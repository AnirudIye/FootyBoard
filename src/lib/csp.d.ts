/**
 * Types for `csp.js`, which is plain JavaScript so that `server/` can import it.
 *
 * **A declaration file rather than `allowJs` in `tsconfig.node.json`**, which was
 * tried first and is why this note exists: `vite.config.ts` is the only file that
 * config includes, and turning `allowJs` on there sent `tsc -b` out of memory
 * rather than producing an error. `tsconfig.app.json` already sets `allowJs` for
 * `src`, so this file is only doing work for the Vite config's compilation.
 *
 * It restates two exports and no values. The policy itself stays in one place;
 * if this ever grows a string literal, it has become the second copy the module
 * exists to prevent.
 */
export declare const DOCUMENT_CSP_DIRECTIVES: readonly string[]
export declare const DOCUMENT_CSP: string
