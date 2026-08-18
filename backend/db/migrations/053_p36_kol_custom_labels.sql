BEGIN;

CREATE TABLE IF NOT EXISTS x_kol_labels (
  id bigserial PRIMARY KEY,
  name text NOT NULL,
  normalized_name text NOT NULL UNIQUE,
  created_by text NOT NULL DEFAULT 'admin',
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_x_kol_labels_name_length
    CHECK (char_length(btrim(name)) BETWEEN 1 AND 24),
  CONSTRAINT chk_x_kol_labels_normalized_name_length
    CHECK (char_length(btrim(normalized_name)) BETWEEN 1 AND 24)
);

CREATE TABLE IF NOT EXISTS x_kol_account_labels (
  kol_id integer NOT NULL REFERENCES x_kol_accounts(id) ON DELETE CASCADE,
  label_id bigint NOT NULL REFERENCES x_kol_labels(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  PRIMARY KEY (kol_id, label_id)
);

CREATE INDEX IF NOT EXISTS idx_x_kol_account_labels_label
  ON x_kol_account_labels(label_id, kol_id);

COMMIT;
