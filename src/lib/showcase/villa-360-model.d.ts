import type { Group } from "three";

/**
 * Build the villa as a three.js group.
 *
 * `night` is not a lighting flag — the generated model swaps materials for the
 * evening scheme, so the group has to be rebuilt rather than re-lit.
 */
export declare function createVilla(night: boolean): Group;
