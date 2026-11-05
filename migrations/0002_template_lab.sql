CREATE TABLE template_media (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user(id),
  object_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  content_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  access_token TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX template_media_user ON template_media(user_id, created_at);

CREATE TABLE template_generation (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user(id),
  request_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  template_id TEXT NOT NULL,
  template_version INTEGER NOT NULL,
  provider_body TEXT NOT NULL,
  provider_task_id TEXT,
  status TEXT NOT NULL,
  estimated_credits REAL,
  consumed_credits REAL,
  refunded_credits REAL,
  result_object_key TEXT,
  error TEXT,
  lease_id TEXT,
  lease_until TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(user_id, request_id)
);
CREATE INDEX template_generation_user ON template_generation(user_id, created_at);
