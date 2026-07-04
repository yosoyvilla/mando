// Builds the `mando` agent into a standalone Bun executable, stamping the
// release version into it via Bun.build's `define`.
//
// This is a plain script rather than a `bun build --define ...` line in
// package.json/CI YAML because `--define` needs a JSON-stringified value
// (quotes around quotes) which is a reliable way to break shell/YAML
// quoting once it crosses a workflow file; a script keeps that quoting in
// one place, in TypeScript, instead of re-deriving it per invocation site.
//
// Usage:
//   bun run build.ts                                   # host platform -> dist/mando
//   bun run build.ts --target=bun-linux-x64 --outfile=dist/mando-linux-x64
//
// MANDO_VERSION (env var, set by CI to the git tag) becomes the version
// baked into the binary; unset, it defaults to "0.0.0-dev" (see version.ts).
import { join } from "node:path";

interface Args {
  target?: Bun.Build.CompileTarget;
  outfile: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { outfile: "dist/mando" };

  for (const arg of argv) {
    const eq = arg.indexOf("=");
    if (eq === -1) {
      throw new Error(`unrecognized argument: ${arg} (expected --flag=value)`);
    }
    const flag = arg.slice(0, eq);
    const value = arg.slice(eq + 1);

    switch (flag) {
      case "--target":
        // Cast: Bun.Build.CompileTarget is a closed set of template-literal
        // strings; an unsupported value here fails loudly from Bun.build
        // itself below rather than needing to be re-validated here.
        args.target = value as Bun.Build.CompileTarget;
        break;
      case "--outfile":
        args.outfile = value;
        break;
      default:
        throw new Error(`unrecognized argument: ${arg}`);
    }
  }

  return args;
}

async function main(): Promise<void> {
  const { target, outfile } = parseArgs(process.argv.slice(2));
  const version = process.env.MANDO_VERSION ?? "0.0.0-dev";
  // Resolve the entrypoint against this script's own location (not the
  // caller's cwd) so `bun run build.ts ...` works the same whether it's
  // invoked from the repo root or from packages/agent.
  const entrypoint = join(import.meta.dir, "src/index.ts");

  const result = await Bun.build({
    entrypoints: [entrypoint],
    compile: {
      outfile,
      ...(target ? { target } : {}),
    },
    define: {
      "process.env.MANDO_VERSION": JSON.stringify(version),
    },
  });

  if (!result.success) {
    for (const log of result.logs) {
      console.error(log);
    }
    process.exit(1);
  }

  console.log(`built ${outfile} (version ${version}${target ? `, target ${target}` : ""})`);
}

void main();
