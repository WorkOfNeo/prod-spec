-- Add MANUAL_IMPORT value to TriggerSource enum.
-- Used by the /import flow when an operator promotes ghost items to Style
-- rows (bulk Manual Import or one-click Accept on a new Customer × BA pair).
ALTER TYPE "TriggerSource" ADD VALUE 'MANUAL_IMPORT';
