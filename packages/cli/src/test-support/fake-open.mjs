#!/usr/bin/env node

import { appendFileSync } from "node:fs";

appendFileSync(process.env.COLOOP_TEST_OPEN_LOG, `${process.argv[2]}\n`);
