// One Key — Chrome native messaging host.
//
// Chrome launches this program and talks to it over stdin/stdout using 32-bit
// length-prefixed JSON. All it does is pass those messages to the running One
// Key app over a named pipe and pass the replies back.
//
// Why a separate console program instead of the Electron app itself: Electron's
// main process does not wire up stdin (it is a dummy stream that ends at once),
// and it writes a stray CRLF to stdout during startup, which Chrome would read
// as the beginning of a length prefix. A plain console app has neither problem,
// starts in milliseconds, and holds no key material of its own.
//
// Built by tools/build-host.ps1 using the .NET Framework compiler that ships
// with Windows — no external toolchain.

using System;
using System.Globalization;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Text.RegularExpressions;

internal static class OneKeyHost
{
    // Chrome's own limit is 1 MB per message; nothing here comes close.
    private const int MaxMessageBytes = 1024 * 1024;

    private static Stream _stdout;

    private static NamedPipeClientStream _pipe;
    private static StreamWriter _pipeWriter;
    private static StreamReader _pipeReader;

    private static int Main(string[] args)
    {
        // Chrome passes the calling extension's origin as an argument. Its
        // manifest whitelist is the real gate; this is a second check.
        bool fromExtension = false;
        foreach (string a in args)
        {
            if (a != null && a.StartsWith("chrome-extension://", StringComparison.Ordinal))
            {
                fromExtension = true;
            }
        }
        if (!fromExtension)
        {
            Console.Error.WriteLine("one-key host: launched without an extension origin; exiting.");
            return 1;
        }

        _stdout = Console.OpenStandardOutput();
        Stream stdin = Console.OpenStandardInput();

        try
        {
            Pump(stdin);
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("one-key host: " + ex.Message);
        }
        finally
        {
            ClosePipe();
        }
        return 0;
    }

    /// <summary>
    /// Every request gets exactly one reply, so request and response are handled
    /// on this one thread. An earlier version read replies on a background
    /// thread; when that reader saw a momentary end-of-stream it exited and
    /// silently swallowed every later reply. Straight-line code cannot fail that
    /// way.
    /// </summary>
    private static void Exchange(string message, string rid)
    {
        _pipeWriter.Write(message);
        _pipeWriter.Write('\n');
        _pipeWriter.Flush();

        string reply = _pipeReader.ReadLine();
        if (reply == null) throw new IOException("One Key closed the connection");
        SendRaw(reply);
    }

    /// <summary>Read length-prefixed frames from Chrome until stdin closes.</summary>
    private static void Pump(Stream stdin)
    {
        byte[] header = new byte[4];
        while (true)
        {
            if (!ReadExactly(stdin, header, 4)) return; // Chrome closed the port

            uint length = (uint)(header[0] | (header[1] << 8) | (header[2] << 16) | (header[3] << 24));
            if (length == 0 || length > MaxMessageBytes) return;

            byte[] body = new byte[length];
            if (!ReadExactly(stdin, body, (int)length)) return;

            string message = Encoding.UTF8.GetString(body);
            Handle(message);
        }
    }

    private static void Handle(string message)
    {
        string rid = ExtractRid(message);

        if (message.IndexOf("\"openApp\"", StringComparison.Ordinal) >= 0)
        {
            LaunchApp(rid);
            return;
        }

        // One retry: a pipe kept from an earlier request may have been closed by
        // the app locking in between, and reconnecting is cheap.
        for (int attempt = 0; attempt < 2; attempt++)
        {
            try
            {
                EnsurePipe();
            }
            catch (Exception)
            {
                SendRaw("{\"rid\":" + rid + ",\"ok\":false,\"code\":\"APP_NOT_RUNNING\"," +
                        "\"message\":\"One Key is not running or is locked.\"}");
                return;
            }

            try
            {
                Exchange(message, rid);
                return;
            }
            catch (Exception)
            {
                ClosePipe();
                if (attempt == 1)
                {
                    SendRaw("{\"rid\":" + rid + ",\"ok\":false,\"code\":\"APP_NOT_RUNNING\"," +
                            "\"message\":\"Lost the connection to One Key.\"}");
                }
            }
        }
    }

    // ---------------------------------------------------------------- the pipe

    /// <summary>
    /// The app writes its pipe name and a connection token to bridge.json while
    /// the vault is unlocked, and deletes the file on lock. A missing file is
    /// therefore the normal "locked or not running" case, not an error.
    /// </summary>
    private static void EnsurePipe()
    {
        if (_pipe != null && _pipe.IsConnected) return;
        ClosePipe();

        string configPath = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
            "One Key", "vault", "bridge.json");

        string json = File.ReadAllText(configPath);
        string pipeName = ExtractString(json, "pipeName");
        string token = ExtractString(json, "token");
        if (pipeName.Length == 0 || token.Length == 0) throw new IOException("bridge.json is incomplete");

        NamedPipeClientStream pipe = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut);
        pipe.Connect(3000);

        StreamWriter writer = new StreamWriter(pipe, new UTF8Encoding(false));
        StreamReader reader = new StreamReader(pipe, new UTF8Encoding(false));

        writer.Write("{\"type\":\"hello\",\"rid\":0,\"token\":\"" + token + "\"}\n");
        writer.Flush();

        string hello = reader.ReadLine();
        if (hello == null || hello.IndexOf("\"ok\":true", StringComparison.Ordinal) < 0)
        {
            pipe.Dispose();
            throw new IOException("One Key refused the connection");
        }

        _pipe = pipe;
        _pipeWriter = writer;
        _pipeReader = reader;
    }

    private static void ClosePipe()
    {
        if (_pipe != null)
        {
            try { _pipe.Dispose(); } catch (Exception) { }
            _pipe = null;
            _pipeWriter = null;
            _pipeReader = null;
        }
    }

    // ------------------------------------------------------------------ output

    private static void SendRaw(string json)
    {
        byte[] body = Encoding.UTF8.GetBytes(json);
        byte[] header = new byte[4];
        header[0] = (byte)(body.Length & 0xFF);
        header[1] = (byte)((body.Length >> 8) & 0xFF);
        header[2] = (byte)((body.Length >> 16) & 0xFF);
        header[3] = (byte)((body.Length >> 24) & 0xFF);

        _stdout.Write(header, 0, 4);
        _stdout.Write(body, 0, body.Length);
        _stdout.Flush();
    }

    // ------------------------------------------------------------------ launch

    /// <summary>
    /// Start the desktop app so the user can unlock it. The path is read from a
    /// file the setup script wrote, because this is needed precisely when the
    /// app is not running and bridge.json does not exist.
    /// </summary>
    private static void LaunchApp(string rid)
    {
        try
        {
            string exe = FindAppExe();
            if (exe == null)
            {
                SendRaw("{\"rid\":" + rid + ",\"ok\":false,\"code\":\"LAUNCH_FAILED\"," +
                        "\"message\":\"Could not find One Key on this machine.\"}");
                return;
            }
            System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(exe)
            {
                UseShellExecute = true,
                WorkingDirectory = Path.GetDirectoryName(exe)
            });
            SendRaw("{\"rid\":" + rid + ",\"ok\":true,\"launched\":true}");
        }
        catch (Exception ex)
        {
            SendRaw("{\"rid\":" + rid + ",\"ok\":false,\"code\":\"LAUNCH_FAILED\",\"message\":" +
                    Quote(ex.Message) + "}");
        }
    }

    private static string FindAppExe()
    {
        // Normally this host sits next to One Key.exe in the install folder.
        string beside = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "One Key.exe");
        if (File.Exists(beside)) return beside;

        // Otherwise fall back to the path recorded at setup time.
        string pointer = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "One Key", "app-path.txt");
        if (File.Exists(pointer))
        {
            string recorded = File.ReadAllText(pointer).Trim();
            if (recorded.Length > 0 && File.Exists(recorded)) return recorded;
        }
        return null;
    }

    // ------------------------------------------------------- tiny JSON helpers

    // Deliberately minimal: this program only ever needs one integer and two
    // strings out of JSON it produced or the app produced. Pulling in a real
    // parser would add a dependency for no benefit.

    private static string ExtractRid(string json)
    {
        Match m = Regex.Match(json, "\"rid\"\\s*:\\s*(\\d+)");
        return m.Success ? m.Groups[1].Value : "null";
    }

    private static string ExtractString(string json, string key)
    {
        Match m = Regex.Match(json, "\"" + Regex.Escape(key) + "\"\\s*:\\s*\"([^\"\\\\]*)\"");
        return m.Success ? m.Groups[1].Value : string.Empty;
    }

    private static string Quote(string text)
    {
        StringBuilder sb = new StringBuilder("\"");
        foreach (char c in text)
        {
            if (c == '"' || c == '\\') sb.Append('\\').Append(c);
            else if (c < ' ') sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
            else sb.Append(c);
        }
        return sb.Append('"').ToString();
    }

    // ------------------------------------------------------------------ stream

    private static bool ReadExactly(Stream stream, byte[] buffer, int count)
    {
        int read = 0;
        while (read < count)
        {
            int n = stream.Read(buffer, read, count - read);
            if (n <= 0) return false;
            read += n;
        }
        return true;
    }
}
