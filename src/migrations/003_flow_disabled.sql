-- wip schema v3: a flow can be switched off. 1: disabled; it hides the flow and freezes its items.
ALTER TABLE flows ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1));
