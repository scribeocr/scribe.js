// Every flag is committed `false`; flip one locally and leave it unstaged.
// A flag belongs here only if a developer flips it while working, or an operator sets it to configure a deployment.
// Each flag must stay a literal `true`/`false`: a computed or environment-read value silently stops the bundler from dropping the guarded branch.

/** Install the developer-only Debug menu in the basic viewer's app menu. */
export const DEBUG_MENU = false;
