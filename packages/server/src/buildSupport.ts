import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

export type DesktopRuntimeTarget =
	| "darwin-arm64"
	| "darwin-x64"
	| "linux-arm64"
	| "linux-x64"
	| "win32-x64";

export interface BundledExtensionSource {
	readonly specifier: string;
	readonly entry: string;
	readonly skills?: string;
}

export interface BuildRuntimeSources {
	readonly extensions: readonly BundledExtensionSource[];
	readonly ptyLibraries: Readonly<Record<DesktopRuntimeTarget, string>>;
	readonly trashHelpers: {
		readonly macos: string;
		readonly windows: string;
	};
}

const require = createRequire(import.meta.url);

function requiredPath(path: string): string {
	if (!existsSync(path)) throw new Error(`required runtime source is missing: ${path}`);
	return path;
}

/**
 * The bundled pi extensions, in load order. This order is a cross-mode invariant: the binary's
 * generated `bundledExtensionFactories` array and dev mode's resolved extension paths are both
 * index-aligned with this list (see agent/SPEC.md).
 */
export const BUNDLED_EXTENSION_PACKAGES: readonly { name: string; skills?: boolean }[] = [
	{ name: "pi-web-access" },
	{ name: "pi-visualize" },
	{ name: "pi-spec-graph", skills: true },
	{ name: "pi-thinkrail-workflow", skills: true },
	{ name: "pi-todos", skills: true },
];

export function resolveBuildRuntimeSources(): BuildRuntimeSources {
	const extensions = BUNDLED_EXTENSION_PACKAGES.map(({ name, skills }) => {
		const specifier = `${name}/index.ts`;
		const entry = require.resolve(specifier);
		return {
			specifier,
			entry,
			...(skills ? { skills: requiredPath(join(dirname(entry), "skills")) } : {}),
		};
	});
	const ptyRelease = join(
		dirname(require.resolve("bun-pty")),
		"..",
		"rust-pty",
		"target",
		"release",
	);
	const trashLib = join(dirname(require.resolve("trash")), "lib");
	return {
		extensions,
		ptyLibraries: {
			"darwin-arm64": requiredPath(join(ptyRelease, "librust_pty_arm64.dylib")),
			"darwin-x64": requiredPath(join(ptyRelease, "librust_pty.dylib")),
			"linux-arm64": requiredPath(join(ptyRelease, "librust_pty_arm64.so")),
			"linux-x64": requiredPath(join(ptyRelease, "librust_pty.so")),
			"win32-x64": requiredPath(join(ptyRelease, "rust_pty.dll")),
		},
		trashHelpers: {
			macos: requiredPath(join(trashLib, "macos-trash")),
			windows: requiredPath(join(trashLib, "windows-trash.exe")),
		},
	};
}
