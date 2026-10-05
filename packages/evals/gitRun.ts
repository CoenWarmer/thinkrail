export function git(cwd: string, args: string[]): string {
	const result = Bun.spawnSync(["git", "-C", cwd, ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});
	if (!result.success) {
		const err = result.stderr.toString().trim();
		throw new Error(`git ${args.join(" ")} failed in ${cwd}${err ? `: ${err}` : ""}`);
	}
	return result.stdout.toString();
}
