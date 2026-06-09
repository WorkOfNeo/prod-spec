-- Track Sync (ghost-DB sink) runs as SyncJob rows so the Monday admin
-- page can show progress / elapsed time the same way it does for Fill.
ALTER TYPE "SyncKind" ADD VALUE 'SINK_ALL';
ALTER TYPE "SyncKind" ADD VALUE 'SINK_BOARD';
