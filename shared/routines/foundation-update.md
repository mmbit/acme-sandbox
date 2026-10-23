Take the foundation's updates, for a company whose repository receives them on a `foundation` branch: its maintainers
push there, nobody else does, and nothing goes back.

1. `git fetch origin foundation`. No such branch, or nothing on it that main lacks (`git log main..origin/foundation`
   is empty): end here, one line in your report.
2. Merge `origin/foundation` into your branch. Where it and the company's own changes differ in a foundation file
   (`platform/`, `infra/`, `shared/`, `.github/`, `docs/`, `CODE_STYLE.md`, the gates' config), keep both where they
   can live together, else the foundation's, and move the company's part into its own folders. The company's own
   folders (`company/`, `theme/`, `products/`, `kits/`, `knowledge/`) keep the company's side.
3. Run the gates and the tests the merge touches; fix what breaks in the company's code, not the foundation's.
4. Your pull request goes through review as any other. Its description: what the update brings, in a few lines from
   its commit messages.

Never push to `foundation`, and never send anything back to its maintainers.
