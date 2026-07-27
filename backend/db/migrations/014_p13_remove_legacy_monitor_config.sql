-- P13 removes the inactive polling configuration. 6551 production ingestion is WSS-driven.
DELETE FROM config WHERE key = 'x_monitor_config';
