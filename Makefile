.PHONY: install build test lint fmt typecheck checkall checkall-ci bundle-check asset-check e2e dev dev-start dev-stop dev-restart preview pre-commit

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
asset-check:
	bun scripts/asset-check.ts
e2e:
	bunx playwright test
dev dev-start:
	bun run dev
# Serves the IWER-enabled e2e build (not production) on E2E_PORT, default 4253.
preview:
	bunx vite build --mode e2e
	bunx vite preview --mode e2e --port $${E2E_PORT:-4253} --strictPort
dev-stop:
	bun run scripts/dev-stop.ts
dev-restart: dev-stop dev
pre-commit:
	pre-commit run --all-files
