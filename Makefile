.PHONY: install build test lint fmt typecheck checkall checkall-ci bundle-check asset-check audio audio-audition bake e2e update-ab dev dev-start dev-stop dev-restart preview pre-commit

install:
	bun install --frozen-lockfile
build:
	bun run build
test:
	bun run test
lint:
	bun run lint
fmt:
	bun run fmt
typecheck:
	bun run typecheck
checkall: lint typecheck test build bundle-check
checkall-ci: checkall
	gitleaks dir . --redact --no-banner
	gitleaks git --redact --no-banner
	bun audit --audit-level high
	$(MAKE) asset-check
# XRDevice and metaQuest3 survive only in sourcemaps; the other markers survive minification.
BUNDLE_DIR ?= dist
BUNDLE_GREP_FLAGS ?=
IWER_MARKERS := XRDevice|metaQuest3|Meta Quest 3|forceInstall|__goghIwer
bundle-check:
	@test -f "$(BUNDLE_DIR)/index.html" || { echo "bundle-check: $(BUNDLE_DIR)/ missing, run make build first"; exit 1; }
	@fail=0; \
	if grep -rlE $(BUNDLE_GREP_FLAGS) '$(IWER_MARKERS)' "$(BUNDLE_DIR)"; then echo "bundle-check: IWER markers found in $(BUNDLE_DIR)/"; fail=1; fi; \
	chunks=$$(find "$(BUNDLE_DIR)" -name 'iwer-install*'); \
	if [ -n "$$chunks" ]; then echo "$$chunks"; echo "bundle-check: iwer-install chunk found in $(BUNDLE_DIR)/"; fail=1; fi; \
	if [ $$fail -ne 0 ]; then exit 1; fi; \
	echo "bundle-check: $(BUNDLE_DIR)/ contains no IWER code"
# The validator and its self-test need ffmpeg on PATH and run on any build. The byte-identity
# rebuild (master.ts --check) needs ffmpeg 9.0.2 and skips with a WARN on any other build.
asset-check:
	bun scripts/asset-check.ts
	bun scripts/audio/validate.ts --self-test
	bun scripts/audio/master.ts --check
# Masters assets/audio/source/ into public/audio/ and rewrites docs/audio/derivatives.md.
audio:
	bun scripts/audio/master.ts
# Renders the limited and linear takes of each pending crest-limit deviation into build/audio/audition/.
audio-audition:
	bun scripts/audio/master.ts --audition
# Rewrites public/paintings/starry-night/{palette.json,flow.png,regions.png} and their PROVENANCE.md rows.
bake:
	bun scripts/bake/analyze-scan.ts
e2e:
	bunx playwright test
# The served A-to-B update check (P7-A1). Local only, not part of checkall.
update-ab:
	bun scripts/update-ab.ts
dev dev-start:
	bun run dev
# Serves the IWER-enabled e2e build (not production) on E2E_PORT (scripts/ports.ts, default 4253).
# Playwright's webServer runs this target, so the two cannot drift.
preview:
	bunx vite build --mode e2e
	bunx vite preview --mode e2e --strictPort
dev-stop:
	bun run scripts/dev-stop.ts
dev-restart: dev-stop dev
pre-commit:
	pre-commit run --all-files
