'use strict';

/**
 * Errors whose message is safe, and intended, to show the user.
 *
 * The IPC layer in main.js passes an AppError's message straight through to the
 * UI and replaces anything else with a generic apology. That is deliberate: an
 * unexpected error can carry a stack, a file path, or a library's internals, and
 * none of that belongs in a password manager's UI.
 *
 * The flip side is that every failure a user is *meant* to understand — a wrong
 * password, a file that isn't a backup — has to be thrown as an AppError.
 * Throwing a plain Error with a `code` on it is not enough; it reads to the IPC
 * layer as a crash, and the user gets "Something went wrong" for what is really
 * just a typo in a password.
 */

class AppError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AppError';
    this.code = code;
  }
}

module.exports = { AppError };
