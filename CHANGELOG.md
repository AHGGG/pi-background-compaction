# Changelog

## [0.3.0](https://github.com/AHGGG/pi-background-compaction/compare/v0.2.1...v0.3.0) (2026-10-31)


### Features

* retry transient background preparation once by default ([7d95cf4](https://github.com/AHGGG/pi-background-compaction/commit/7d95cf439e8fbb896f3771066907e4e0d8f3b319))
* support text summary preparation with existing auto-apply ([1f930ff](https://github.com/AHGGG/pi-background-compaction/commit/1f930ffd2b0b4a06244f56f9f06c8ec83c150dcf))


### Bug Fixes

* include full diagnostics in background failure warnings ([2cfad9e](https://github.com/AHGGG/pi-background-compaction/commit/2cfad9ee54d91fc4af7eb49a1ad4709827617b4c))
* preserve background preparation across model errors ([2697c02](https://github.com/AHGGG/pi-background-compaction/commit/2697c02a9fa512d25f28316ebee826164c1973c9))
* preserve summary candidates and terminal preparation outcomes ([041afea](https://github.com/AHGGG/pi-background-compaction/commit/041afea4479f4962a24cf9c21be963fae69a9202))

## [0.2.1](https://github.com/AHGGG/pi-background-compaction/compare/v0.2.0...v0.2.1) (2026-10-26)


### Bug Fixes

* report background preparation failures with actionable diagnostics ([cf07e27](https://github.com/AHGGG/pi-background-compaction/commit/cf07e27ec4c8daac8b9dc1b81d23ecdc40653d8c))

## [0.2.0](https://github.com/AHGGG/pi-background-compaction/compare/v0.1.0...v0.2.0) (2026-10-26)


### Features

* enable background compaction by default and automate releases ([cc199e3](https://github.com/AHGGG/pi-background-compaction/commit/cc199e3fd06a5bbaf21be88521b9be2f7df86775))
* extract optional background compaction controller ([4038505](https://github.com/AHGGG/pi-background-compaction/commit/403850504a06d1940bb17ae121a8e65c86e03d83))


### Bug Fixes

* apply ready checkpoints after successful model retries ([40b57dd](https://github.com/AHGGG/pi-background-compaction/commit/40b57dda74de018b6d0224db31c138fb62debb2e))
* keep text checkouts LF across platforms ([51fbf6c](https://github.com/AHGGG/pi-background-compaction/commit/51fbf6c6c0d124fed5916d4591038ec11697ae62))
* reject settings symlinks across platforms ([e9f3ccd](https://github.com/AHGGG/pi-background-compaction/commit/e9f3ccdaaf8c3b718374f5067dc5fc71730a5498))
* reuse pending checkpoints during manual compaction ([9086e64](https://github.com/AHGGG/pi-background-compaction/commit/9086e64812a7fda6abec49902c28960a4c9d914d))
* show safe background failure details and elapsed time ([a7366ba](https://github.com/AHGGG/pi-background-compaction/commit/a7366ba3871d6039a76cf4095962a0e259f19e5d))
