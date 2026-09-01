/**
 * The DOM animation feature bundle, in its own module so the bundler can split
 * it into a chunk that loads *after* the sign-in form is on screen.
 *
 * Importing `motion` directly pulls its whole engine — including layout
 * projection and gesture handling this screen never uses — into the critical
 * path of the one page where nothing is cached and someone is waiting to get in.
 * `domAnimation` alone covers everything here: transforms, opacity and exit
 * animations.
 */
export { domAnimation as default } from "motion/react";
