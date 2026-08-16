#!/usr/bin/env bash
set -euo pipefail

npm run typecheck
npm run test:unit
npm run test:ops
