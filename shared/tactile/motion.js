// Whether the device asks for less motion: every tactile module then lands at once, with its callbacks still called.
export const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
