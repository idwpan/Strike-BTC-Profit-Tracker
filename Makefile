# ----- Paths
SRC         := src
DIST        := dist
BASE        := $(DIST)/base
CHROME_DIR  := $(DIST)/chrome
FIREFOX_DIR := $(DIST)/firefox

# Use manifest.jsonc if available, otherwise manifest.json
SRC_MANIFEST := $(firstword $(wildcard $(SRC)/manifest.jsonc) $(wildcard $(SRC)/manifest.json))

.DEFAULT_GOAL := all
.PHONY: all chrome firefox clean check base \
        stage-chrome stage-firefox firefox-manifest validate-firefox \
        zip-chrome zip-firefox

all: chrome firefox

# ----- Verify required tools exist
check:
	@for bin in jq zip rsync node npx; do \
	  command -v $$bin >/dev/null 2>&1 || { echo "missing required tool: $$bin" >&2; exit 1; }; \
	done

# ----- Copy sources to dist/base with a comment-free manifest
base: $(BASE)/manifest.json

# Ensure base directory exists
$(BASE):
	@mkdir -p "$@"

# Strip comments from manifest and copy source files to base directory
$(BASE)/manifest.json: | $(BASE) check
ifneq ($(suffix $(SRC_MANIFEST)),.jsonc)
	@echo "[base] copy: $(SRC)/manifest.json -> $@"
	@rsync -a "$(SRC)/manifest.json" "$@"
else  # Convert JSONC to JSON
	@echo "[base] strip comments: $(SRC)/manifest.jsonc -> $@"
	@npx -y strip-json-comments-cli "$(SRC)/manifest.jsonc" > "$@"
endif
	@rsync -a --exclude 'manifest.json' --exclude 'manifest.jsonc' "$(SRC)/" "$(BASE)/"

# ----- Save version for naming zip files
$(DIST)/version.txt: base
	@mkdir -p "$(DIST)"
	@jq -r '.version' "$(BASE)/manifest.json" > "$@"

# ----- Prepare browser-specific directories
stage-chrome: base
	@echo "[stage] chrome"
	@rm -rf "$(CHROME_DIR)"
	@rsync -a "$(BASE)/" "$(CHROME_DIR)/"

stage-firefox: base
	@echo "[stage] firefox"
	@rm -rf "$(FIREFOX_DIR)"
	@rsync -a "$(BASE)/" "$(FIREFOX_DIR)/"

# ----- Firefox manifest transforms
# Firefox needs the WebExtension polyfill for Promise-based browser APIs.
# Without it, code written for chrome.* may fail in Firefox.
firefox-manifest: stage-firefox
	@echo "[firefox] transform manifest"
	@jq '.background={"scripts":["vendor/browser-polyfill.js","background.js"]}' \
	  "$(FIREFOX_DIR)/manifest.json" > "$(FIREFOX_DIR)/manifest.tmp"
	@mv "$(FIREFOX_DIR)/manifest.tmp" "$(FIREFOX_DIR)/manifest.json"

validate-firefox: firefox-manifest
	@jq . "$(FIREFOX_DIR)/manifest.json" >/dev/null

# ----- Create versioned zip archives
zip-chrome: stage-chrome $(DIST)/version.txt
	@V=$$(cat "$(DIST)/version.txt"); \
	echo "[chrome] v$$V"; \
	( cd "$(CHROME_DIR)" && zip -qr "../../strike-tracker-chrome-v$$V.zip" . ); \
	echo "[chrome] wrote strike-tracker-chrome-v$$V.zip"

zip-firefox: validate-firefox $(DIST)/version.txt
	@V=$$(cat "$(DIST)/version.txt"); \
	echo "[firefox] v$$V"; \
	( cd "$(FIREFOX_DIR)" && zip -qr "../../strike-tracker-firefox-v$$V.zip" . ); \
	echo "[firefox] wrote strike-tracker-firefox-v$$V.zip"

# Friendly aliases
chrome: zip-chrome
firefox: zip-firefox

# ----- Clean
clean:
	@echo "[clean] removing dist/ and generated zips"
	@rm -rf "$(DIST)"
	@rm -f strike-tracker-*-v*.zip
