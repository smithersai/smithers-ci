// Install the publishable artifact outside the repository, as an ordinary consumer would.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const manifest = JSON.parse(readFileSync("package.json", "utf8"))
const work = mkdtempSync(join(tmpdir(), "smithers-ci-package-"))
const consumer = join(work, "consumer")
const output = resolve("dist/npm")
const node = (args) => execFileSync(process.execPath, args, { cwd: consumer, encoding: "utf8" })

try {
  execFileSync("npm", ["pack", "--pack-destination", work], { stdio: "inherit" })
  const filename = manifest.name + "-" + manifest.version + ".tgz"
  const tarball = join(work, filename)
  mkdirSync(consumer)
  writeFileSync(join(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }))
  execFileSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball, "@types/node@" + manifest.devDependencies["@types/node"]], { cwd: consumer, stdio: "inherit" })

  const entry = (subpath) => manifest.name + subpath.slice(1)
  const imports = Object.keys(manifest.exports).map(entry)
  const probe = `
    import assert from "node:assert/strict"
    for (const specifier of ${JSON.stringify(imports)}) {
      assert.match(import.meta.resolve(specifier), /\\.js$/)
      const api = await import(specifier)
      assert.ok(Object.keys(api).length, specifier)
    }
    import { Audit, Trust } from "smithers-ci"
    import { ratingForScore } from "smithers-ci/audit"
    assert.equal(Audit.ratingForScore, ratingForScore)
    assert.equal(ratingForScore(100), "pass")
    assert.ok(Trust.VALID_TRUST_TIERS.has("untrusted:community"))
  `
  node(["--input-type=module", "-e", probe])
  const types = imports.map((name, index) => `import * as api${index} from ${JSON.stringify(name)}\nvoid api${index}`).join("\n")
  writeFileSync(join(consumer, "check.mts"), types + '\nimport { ratingForScore } from "smithers-ci/audit"\nconst score: "pass" | "average" | "fail" = ratingForScore(90)\nvoid score\n')
  node([resolve("node_modules/typescript/bin/tsc"), "--module", "nodenext", "--target", "es2023", "--strict", "--noEmit", "check.mts"])
  const cli = join(consumer, "node_modules/.bin/smithers-ci")
  assert.match(execFileSync(cli, ["--help"], { cwd: consumer, encoding: "utf8" }), /smithers-ci audit/)
  const inventory = JSON.parse(execFileSync(cli, ["inventory", "--json"], { cwd: consumer, encoding: "utf8" }))
  assert.deepEqual(inventory.workflows, [])
  mkdirSync(output, { recursive: true })
  copyFileSync(tarball, join(output, filename))
  console.log(`Verified ${filename} on Node ${process.versions.node}: ${imports.length} public imports and their declarations, CLI help and inventory.`)
} finally {
  rmSync(work, { recursive: true, force: true })
}
