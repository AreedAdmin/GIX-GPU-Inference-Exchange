# ===========================================================================
# GPU Inference Exchange (GIX) — M1 demo orchestration
#
# Thin root wrapper over ops/scripts/*. Targets:
#   make localnet   start an ephemeral Sui localnet (+faucet)
#   make deploy     publish gix -> deployment.json  (delegates to contracts/)
#   make fund       create + fund test accounts (SUI gas + MOCK_USDC)
#   make demo       localnet + deploy + fund + stream baseline scenario + summary
#   make clean      stop localnet, remove generated artifacts
#
# See ops/README.md for prerequisites and the full runbook.
# All real logic lives in ops/scripts/ so it is independently testable.
# ===========================================================================

OPS        := ops
SCRIPTS    := $(OPS)/scripts
SCENARIO   ?= examples/scenarios/baseline.json
SUMMARY_MD ?=

# Pass-through args, e.g.: make fund FUND_ARGS="--providers 4 --consumers 6"
LOCALNET_ARGS ?=
FUND_ARGS     ?=
DEPLOY_ARGS   ?=

.DEFAULT_GOAL := help
.PHONY: help localnet localnet-stop localnet-reset localnet-status \
        deploy fund demo summary check clean clean-all

help: ## Show this help
	@echo "GIX M1 ops — targets:"
	@grep -E '^[a-zA-Z0-9_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
	  | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'
	@echo ""
	@echo "Vars: SCENARIO=$(SCENARIO)  SUMMARY_MD=<file>  FUND_ARGS=... DEPLOY_ARGS=..."

localnet: ## Start an ephemeral localnet (+faucet) in the background
	@bash $(SCRIPTS)/localnet.sh start $(LOCALNET_ARGS)

localnet-stop: ## Stop the localnet
	@bash $(SCRIPTS)/localnet.sh stop

localnet-reset: ## Reset localnet (full wipe + fresh genesis)
	@bash $(SCRIPTS)/localnet.sh reset $(LOCALNET_ARGS)

localnet-status: ## Show localnet RPC/faucet status
	@bash $(SCRIPTS)/localnet.sh status

deploy: ## Publish gix and produce deployment.json (needs localnet up)
	@bash $(SCRIPTS)/deploy.sh $(DEPLOY_ARGS)

fund: ## Create + fund test accounts (needs deploy done)
	@bash $(SCRIPTS)/fund.sh $(FUND_ARGS)

demo: ## Full end-to-end demo: localnet + deploy + fund + stream + summary
	@bash $(SCRIPTS)/demo.sh --scenario $(SCENARIO) $(if $(SUMMARY_MD),--summary-md $(SUMMARY_MD),)

summary: ## Render a run summary from a tally file: make summary TALLY=path [SUMMARY_MD=out.md]
	@node $(SCRIPTS)/run-summary.js $(if $(TALLY),--input $(TALLY),) \
	  --format $(if $(SUMMARY_MD),both,console) $(if $(SUMMARY_MD),--out $(SUMMARY_MD),)

check: ## Sanity-check scripts + scenarios + fixtures (no localnet needed)
	@bash $(SCRIPTS)/check.sh

clean: ## Stop localnet and remove generated run artifacts
	@bash $(SCRIPTS)/localnet.sh stop || true
	@rm -rf $(OPS)/.run
	@echo "[gix] cleaned ops/.run"

clean-all: clean ## clean + remove generated deployment.json
	@rm -f deployment.json ops/deployment.json
	@echo "[gix] removed deployment.json"
