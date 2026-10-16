"""Preflight Doctor (``lanius-engine --doctor``) tests."""

from __future__ import annotations

import json
import socket

from app import doctor
from app.config import Settings
from app.main import main


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def settings_for(tmp_path, **overrides) -> Settings:
    values = dict(
        proxy_port=free_port(),
        api_port=free_port(),
        data_dir=tmp_path / "home",
        confdir=tmp_path / "mitm",
    )
    values.update(overrides)
    return Settings(**values)


def by_id(report: dict) -> dict[str, dict]:
    return {check["id"]: check for check in report["checks"]}


def test_healthy_machine_passes_every_check(tmp_path) -> None:
    checks = by_id(doctor.run(settings_for(tmp_path)))
    assert [checks[name]["status"] for name in ("runtime", "data_dir", "proxy_port", "api_port", "proxy_start")] == ["ok"] * 5
    # The CA is created by the first real start, never by the Doctor.
    assert checks["ca"]["status"] == "warn"
    assert not (tmp_path / "mitm").exists()


def test_busy_proxy_port_is_an_error(tmp_path) -> None:
    with socket.socket() as holder:
        holder.bind(("127.0.0.1", 0))
        holder.listen(1)
        port = holder.getsockname()[1]
        check = doctor.check_port("proxy_port", "127.0.0.1", port)
    assert check["status"] == "error"
    assert check["address"] == f"127.0.0.1:{port}"


def test_unreadable_ca_is_an_error(tmp_path) -> None:
    (tmp_path / doctor.CA_FILE).write_text("not a certificate")
    assert doctor.check_ca(tmp_path)["status"] == "error"


def test_existing_ca_is_read(tmp_path) -> None:
    from mitmproxy import certs

    certs.CertStore.from_store(tmp_path, "mitmproxy", 2048)
    check = doctor.check_ca(tmp_path)
    assert check["status"] == "ok"
    assert check["detail"].startswith("valid until")


def test_data_dir_that_is_a_file_is_an_error(tmp_path) -> None:
    blocker = tmp_path / "home"
    blocker.write_text("")
    assert doctor.check_data_dir(blocker)["status"] == "error"


def test_failed_proxy_start_is_reported(monkeypatch) -> None:
    async def broken(_confdir):
        raise RuntimeError("native core missing")

    monkeypatch.setattr(doctor, "_start_proxy", broken)
    check = doctor.check_proxy_start()
    assert check["status"] == "error"
    assert "native core missing" in check["detail"]


def test_doctor_flag_prints_json_and_exits(tmp_path, monkeypatch, capsys) -> None:
    monkeypatch.setenv("LANIUS_DATA_DIR", str(tmp_path / "home"))
    monkeypatch.setenv("LANIUS_MITM_CONFDIR", str(tmp_path / "mitm"))
    monkeypatch.setenv("LANIUS_PROXY_PORT", str(free_port()))
    monkeypatch.setenv("LANIUS_API_PORT", str(free_port()))
    main(["--doctor"])
    report = json.loads(capsys.readouterr().out)
    assert report["engine_version"]
    assert {check["id"] for check in report["checks"]} >= {"runtime", "proxy_port", "proxy_start"}
