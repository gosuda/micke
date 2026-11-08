// version — micke's own version string.
//
// WHY a build-time --define with a fallback: the build script (a later unit)
// compiles the CLI with `--define MICKE_BUILD_VERSION:'<tag>'` so the shipped
// binary knows the git tag it was cut from. The "0.0.0-dev" fallback marks a
// run straight from the dev tree (`bun run src/main.ts`), where no tag was
// injected — exactly what `micke version` must be able to say.

declare const MICKE_BUILD_VERSION: string;

export const MICKE_VERSION: string = typeof MICKE_BUILD_VERSION !== "undefined" ? MICKE_BUILD_VERSION : "0.0.0-dev";
