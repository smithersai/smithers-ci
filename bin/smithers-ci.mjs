#!/usr/bin/env node
import { runCli } from "../src/cli/main.ts"

const exitCode = await runCli(process.argv.slice(2), process.cwd())
process.exitCode = exitCode
