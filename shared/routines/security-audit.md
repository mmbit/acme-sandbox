The weekly security audit of the company's apps and sites. Start from what changed since the last weekly audit
(`git log` on `products/`, `kits/`, `theme/` and the sites, from the last audit's dated line in the company's security
note) and from its threat model. Look for realistic ways in: what an attacker could plausibly do to the company or its
customers at its size. Don't harden for the sake of hardening; a finding needs a concrete path (input → harm).

Fix small, clear ones in one pull request; anything bigger goes to its owner as a job, with the path and the smallest
fix. Something big changed (payments, accounts, customer data, a new app going live): queue the product's owner a job
(`hq job`) to arrange the full pre-launch audit (the Review panel playbook), unless `hq jobs` shows one queued already.
Add one dated line to the security note's list of weekly audits (scope, findings, what you fixed or queued, with the
job numbers). Nothing changed and nothing new in the threat model: that line alone, done.
