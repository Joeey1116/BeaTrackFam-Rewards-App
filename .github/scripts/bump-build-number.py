#!/usr/bin/env python3
"""Bump the build number by 1 (iOS buildNumber + Android versionCode, in sync).

App Store Connect and Google Play both reject a re-upload of a build number
they already have (hit Nov 10, 2026: Rewards 2.0.0 build 2001 failed the
TestFlight upload 3x with "The bundle version must be higher than the
previously uploaded version: '2001'"). Every GitHub build run calls this
first, so a rebuild can never collide with an already-uploaded build.

The marketing version (expo.version, e.g. 2.0.0) is NOT touched — that only
changes on a release, by hand. The new number is saved back to the repo by
the workflow's commit-back step after a successful build.

The edit is surgical (regex on the two lines only) so app.json formatting is
preserved byte-for-byte everywhere else.
"""
import json
import re
import sys

PATH = "app.json"

with open(PATH, encoding="utf-8") as f:
    text = f.read()

try:
    data = json.loads(text)
except json.JSONDecodeError as e:
    print(f"::error::app.json is not valid JSON: {e}")
    sys.exit(1)

try:
    ios_build = int(data["expo"]["ios"]["buildNumber"])
    android_code = int(data["expo"]["android"]["versionCode"])
except (KeyError, TypeError, ValueError) as e:
    print(f"::error::Could not read build numbers from app.json: {e}")
    sys.exit(1)

new_ios = ios_build + 1
new_android = android_code + 1

new_text, n1 = re.subn(
    r'("buildNumber"\s*:\s*")\d+(")', rf"\g<1>{new_ios}\g<2>", text, count=1
)
new_text, n2 = re.subn(
    r'("versionCode"\s*:\s*)\d+', rf"\g<1>{new_android}", new_text, count=1
)

if n1 != 1 or n2 != 1:
    print("::error::Could not find buildNumber/versionCode in app.json to bump.")
    sys.exit(1)

with open(PATH, "w", encoding="utf-8") as f:
    f.write(new_text)

print(f"Bumped build number: iOS {ios_build} -> {new_ios}, "
      f"Android {android_code} -> {new_android}")
