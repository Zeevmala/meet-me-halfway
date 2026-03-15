"""
i18n message templates for the WhatsApp bot.
Pure functions -- no side effects, no I/O.
"""

from __future__ import annotations

TEMPLATES: dict[str, dict[str, str]] = {
    "en": {
        "session_created": (
            "Meet Me Halfway session created!" " Share this link with your group: {link}"
        ),
        "participant_joined": (
            "{name} joined ({count}/{max})." " Waiting for everyone to share their location."
        ),
        "midpoint_ready": (
            "Your meeting point is ready!" " Top suggestion: {venue}. See all options: {link}"
        ),
        "location_request": ("Share your location to find the best meeting point!"),
        "location_received": ("Got your location, {name}! Waiting for others to join."),
        "waiting_for_others": (
            "{have} location(s) received." " Need at least {need} to calculate the meeting point."
        ),
        "no_active_session": ("No active session found. Send 'meetme' to start one!"),
    },
    "he": {
        "session_created": (
            "\u05e0\u05d5\u05e6\u05e8\u05d4 \u05e4\u05d2\u05d9\u05e9\u05d4"
            " \u05d7\u05d3\u05e9\u05d4 \u05d1-Meet Me Halfway!"
            " \u05e9\u05ea\u05e3/\u05d9 \u05d0\u05ea"
            " \u05d4\u05e7\u05d9\u05e9\u05d5\u05e8"
            " \u05e2\u05dd \u05d4\u05e7\u05d1\u05d5\u05e6\u05d4: {link}"
        ),
        "participant_joined": (
            "{name}"
            " \u05d4\u05e6\u05d8\u05e8\u05e3/\u05d4"
            " ({count}/{max})."
            " \u05de\u05de\u05ea\u05d9\u05df/\u05d4"
            " \u05dc\u05db\u05d5\u05dc\u05dd"
            " \u05dc\u05e9\u05ea\u05e3 \u05de\u05d9\u05e7\u05d5\u05dd."
        ),
        "midpoint_ready": (
            "\u05e0\u05e7\u05d5\u05d3\u05ea \u05d4\u05de\u05e4\u05d2\u05e9"
            " \u05e9\u05dc\u05db\u05dd \u05de\u05d5\u05db\u05e0\u05d4!"
            " \u05d4\u05d4\u05e6\u05e2\u05d4"
            " \u05d4\u05d8\u05d5\u05d1\u05d4"
            " \u05d1\u05d9\u05d5\u05ea\u05e8: {venue}."
            " \u05db\u05dc"
            " \u05d4\u05d0\u05e4\u05e9\u05e8\u05d5\u05d9\u05d5\u05ea: {link}"
        ),
        "location_request": (
            "\u05e9\u05ea\u05e3/\u05d9 \u05de\u05d9\u05e7\u05d5\u05dd"
            " \u05db\u05d3\u05d9 \u05dc\u05de\u05e6\u05d5\u05d0"
            " \u05d0\u05ea \u05e0\u05e7\u05d5\u05d3\u05ea"
            " \u05d4\u05de\u05e4\u05d2\u05e9"
            " \u05d4\u05d0\u05d9\u05d3\u05d9\u05d0\u05dc\u05d9\u05ea!"
        ),
        "location_received": (
            "\u05d4\u05de\u05d9\u05e7\u05d5\u05dd \u05e9\u05dc {name}"
            " \u05d4\u05ea\u05e7\u05d1\u05dc!"
            " \u05de\u05de\u05ea\u05d9\u05df/\u05d4"
            " \u05dc\u05d0\u05d7\u05e8\u05d9\u05dd."
        ),
        "waiting_for_others": (
            "\u05d4\u05ea\u05e7\u05d1\u05dc\u05d5 {have}"
            " \u05de\u05d9\u05e7\u05d5\u05de\u05d9\u05dd."
            " \u05e6\u05e8\u05d9\u05da \u05dc\u05e4\u05d7\u05d5\u05ea"
            " {need} \u05db\u05d3\u05d9 \u05dc\u05d7\u05e9\u05d1."
        ),
        "no_active_session": (
            "\u05dc\u05d0 \u05e0\u05de\u05e6\u05d0 \u05e1\u05e9\u05df"
            " \u05e4\u05e2\u05d9\u05dc."
            " \u05e9\u05dc\u05d7/\u05d9 'meetme'"
            " \u05db\u05d3\u05d9 \u05dc\u05d4\u05ea\u05d7\u05d9\u05dc!"
        ),
    },
    "ar": {
        "session_created": (
            "\u062a\u0645 \u0625\u0646\u0634\u0627\u0621"
            " \u062c\u0644\u0633\u0629 Meet Me Halfway!"
            " \u0634\u0627\u0631\u0643 \u0627\u0644\u0631\u0627\u0628\u0637"
            " \u0645\u0639 \u0645\u062c\u0645\u0648\u0639\u062a\u0643: {link}"
        ),
        "participant_joined": (
            "\u0627\u0646\u0636\u0645/\u062a {name}"
            " ({count}/{max})."
            " \u0641\u064a \u0627\u0646\u062a\u0638\u0627\u0631"
            " \u0627\u0644\u062c\u0645\u064a\u0639"
            " \u0644\u0645\u0634\u0627\u0631\u0643\u0629"
            " \u0645\u0648\u0642\u0639\u0647\u0645."
        ),
        "midpoint_ready": (
            "\u0646\u0642\u0637\u0629 \u0627\u0644\u0644\u0642\u0627\u0621"
            " \u062c\u0627\u0647\u0632\u0629!"
            " \u0623\u0641\u0636\u0644 \u0627\u0642\u062a\u0631\u0627\u062d:"
            " {venue}."
            " \u062c\u0645\u064a\u0639"
            " \u0627\u0644\u062e\u064a\u0627\u0631\u0627\u062a: {link}"
        ),
        "location_request": (
            "\u0634\u0627\u0631\u0643 \u0645\u0648\u0642\u0639\u0643"
            " \u0644\u0644\u0639\u062b\u0648\u0631 \u0639\u0644\u0649"
            " \u0623\u0641\u0636\u0644 \u0646\u0642\u0637\u0629 \u0644\u0642\u0627\u0621!"
        ),
        "location_received": (
            "\u062a\u0645 \u0627\u0633\u062a\u0644\u0627\u0645"
            " \u0645\u0648\u0642\u0639 {name}!"
            " \u0641\u064a \u0627\u0646\u062a\u0638\u0627\u0631"
            " \u0627\u0644\u0622\u062e\u0631\u064a\u0646."
        ),
        "waiting_for_others": (
            "\u062a\u0645 \u0627\u0633\u062a\u0644\u0627\u0645 {have}"
            " \u0645\u0648\u0642\u0639/\u0645\u0648\u0627\u0642\u0639."
            " \u064a\u062c\u0628 \u0627\u0633\u062a\u0644\u0627\u0645"
            " {need} \u0639\u0644\u0649 \u0627\u0644\u0623\u0642\u0644"
            " \u0644\u0644\u062d\u0633\u0627\u0628."
        ),
        "no_active_session": (
            "\u0644\u0645 \u064a\u062a\u0645 \u0627\u0644\u0639\u062b\u0648\u0631"
            " \u0639\u0644\u0649 \u062c\u0644\u0633\u0629 \u0646\u0634\u0637\u0629."
            " \u0623\u0631\u0633\u0644 'meetme'"
            " \u0644\u0628\u062f\u0621 \u062c\u0644\u0633\u0629 \u062c\u062f\u064a\u062f\u0629!"
        ),
    },
}

_FALLBACK = "en"


def _t(key: str, locale: str) -> str:
    msgs = TEMPLATES.get(locale, TEMPLATES[_FALLBACK])
    return msgs.get(key, TEMPLATES[_FALLBACK][key])


def session_created(link: str, locale: str = "en") -> str:
    return _t("session_created", locale).format(link=link)


def participant_joined(name: str, count: int, max_p: int, locale: str = "en") -> str:
    return _t("participant_joined", locale).format(name=name, count=count, max=max_p)


def midpoint_ready(venue_name: str, link: str, locale: str = "en") -> str:
    return _t("midpoint_ready", locale).format(venue=venue_name, link=link)


def location_request(locale: str = "en") -> str:
    return _t("location_request", locale)


def location_received(name: str, locale: str = "en") -> str:
    return _t("location_received", locale).format(name=name)


def waiting_for_others(have: int, need: int, locale: str = "en") -> str:
    return _t("waiting_for_others", locale).format(have=have, need=need)


def no_active_session(locale: str = "en") -> str:
    return _t("no_active_session", locale)
