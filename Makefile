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
	bun audit --audit-level high
	$(MAKE) asset-check
bundle-check:
	@echo "bundle-check: no-op until P0.3"
asset-check:
	bun scripts/asset-check.ts
e2e:
	@echo "e2e suite arrives in P0.3"
dev dev-start:
	bun run dev
preview:
	bun run preview
dev-stop:
	bun run scripts/dev-stop.ts
dev-restart: dev-stop dev
pre-commit:
	pre-commit run --all-files
