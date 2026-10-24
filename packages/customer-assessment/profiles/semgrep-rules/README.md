# Gotchu Semgrep rules

Version 1.0.0, authored for this repository and evaluated with Semgrep 1.182.0. The rules are vendored in `../semgrep.yaml`; they are original rules and do not copy Semgrep Community/Registry rules, whose current license excludes redistribution as a competing service. The rule pack is distributed under the MIT license in `LICENSE`.

Each rule carries a CWE, OWASP Top 10 category, and a precision note in its Semgrep metadata. Matches remain static indications; the notes describe syntactic precision, not exploitability or runtime reachability. Update the pack version and live positive/negative controls when changing the rule set.
