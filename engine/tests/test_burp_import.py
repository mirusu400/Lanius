from __future__ import annotations

import json

from app.addons.match_replace import MatchReplaceRule
from app.burp_import import convert_burp_settings


def test_regex_replacement_groups_are_translated_from_burp_syntax() -> None:
    plan = convert_burp_settings({
        "proxy": {
            "match_replace_rules": [{
                "comment": "capture replacement",
                "enabled": True,
                "is_simple_match": False,
                "rule_type": "request_header",
                "string_match": r"^X-Old: (.*)$",
                "string_replace": r"X-New: $1 / \$1",
            }],
        },
    })

    [value] = json.loads(plan.settings["match_replace_rules"])
    rule = MatchReplaceRule.from_dict(value)
    assert rule.substitute("X-Old: value") == "X-New: value / $1"
