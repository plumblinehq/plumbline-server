-- Plumbline schema, base migration.
--
-- Adapted from plumbline-architecture.md §6.1 (the Go-era module, whose data
-- model this prompt still honours) with two additions the build's governing
-- master prompt requires: `assets` and `regressions`.
--
-- Every run records `checks_lib_version`. Without it a grade change across
-- runs could mean the anchor broke or that Plumbline changed — the version is
-- what makes historical comparison trustworthy at all.

CREATE TABLE anchors (
    id            BIGSERIAL PRIMARY KEY,
    home_domain   TEXT NOT NULL UNIQUE,
    network       TEXT NOT NULL,          -- pubnet | testnet
    display_name  TEXT,
    added_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    enabled       BOOLEAN NOT NULL DEFAULT TRUE,
    opted_out     BOOLEAN NOT NULL DEFAULT FALSE,
    opt_out_note  TEXT
);

CREATE TABLE assets (
    id            BIGSERIAL PRIMARY KEY,
    anchor_id     BIGINT NOT NULL REFERENCES anchors(id) ON DELETE CASCADE,
    code          TEXT NOT NULL,
    issuer        TEXT,                   -- G... when the asset is classic
    contract      TEXT,                   -- C... when the asset is a SAC
    CONSTRAINT assets_issuer_or_contract CHECK (
        (issuer IS NULL) <> (contract IS NULL)
    ),
    UNIQUE (anchor_id, code, issuer, contract)
);

CREATE TABLE runs (
    id            BIGSERIAL PRIMARY KEY,
    anchor_id     BIGINT NOT NULL REFERENCES anchors(id) ON DELETE CASCADE,
    started_at    TIMESTAMPTZ NOT NULL,
    finished_at   TIMESTAMPTZ,
    checks_lib_version TEXT NOT NULL,     -- the checks VERSION export, for reproducibility
    overall_score NUMERIC(4,3),
    status        TEXT NOT NULL           -- running | complete | aborted
);
CREATE INDEX runs_anchor_started_idx ON runs (anchor_id, started_at DESC);

CREATE TABLE check_results (
    id          BIGSERIAL PRIMARY KEY,
    run_id      BIGINT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    check_id    TEXT NOT NULL,
    sep         INT NOT NULL,
    status      TEXT NOT NULL,            -- pass | fail | skip | error
    severity    TEXT NOT NULL,            -- error | warning | info
    message     TEXT,
    spec_ref    TEXT,
    evidence    JSONB,
    duration_ms INT
);
CREATE INDEX check_results_run_idx ON check_results (run_id);
CREATE INDEX check_results_check_status_idx ON check_results (check_id, status);

CREATE TABLE sep_grades (
    run_id BIGINT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    sep    INT NOT NULL,
    score  NUMERIC(4,3) NOT NULL,         -- passed error checks / applicable error checks
    applicable BOOLEAN NOT NULL,
    PRIMARY KEY (run_id, sep)
);

CREATE TABLE regressions (
    id          BIGSERIAL PRIMARY KEY,
    anchor_id   BIGINT NOT NULL REFERENCES anchors(id) ON DELETE CASCADE,
    run_id      BIGINT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    check_id    TEXT NOT NULL,
    -- pass → fail on an error-severity check, the only transition alerted on
    detected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (anchor_id, check_id, run_id)
);
CREATE INDEX regressions_anchor_idx ON regressions (anchor_id, detected_at DESC);
