-- CreateTable
CREATE TABLE "monday_ghost_boards" (
    "id" TEXT NOT NULL,
    "mondayBoardId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "label" TEXT,
    "itemCount" INTEGER NOT NULL DEFAULT 0,
    "lastSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "monday_ghost_boards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "monday_ghost_columns" (
    "id" TEXT NOT NULL,
    "boardId" TEXT NOT NULL,
    "mondayColumnId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "description" TEXT,
    "settings" JSONB NOT NULL DEFAULT 'null',
    "lastSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "monday_ghost_columns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "monday_ghost_items" (
    "id" TEXT NOT NULL,
    "boardId" TEXT NOT NULL,
    "mondayItemId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "groupId" TEXT,
    "groupTitle" TEXT,
    "columnValues" JSONB NOT NULL DEFAULT '[]',
    "lastSyncedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "monday_ghost_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "monday_ghost_dropdown_options" (
    "id" TEXT NOT NULL,
    "boardColumnId" TEXT NOT NULL,
    "optionId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "color" TEXT,
    "lastSyncedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "monday_ghost_dropdown_options_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "monday_ghost_boards_mondayBoardId_key" ON "monday_ghost_boards"("mondayBoardId");

-- CreateIndex
CREATE INDEX "monday_ghost_columns_boardId_idx" ON "monday_ghost_columns"("boardId");

-- CreateIndex
CREATE INDEX "monday_ghost_columns_type_idx" ON "monday_ghost_columns"("type");

-- CreateIndex
CREATE UNIQUE INDEX "monday_ghost_columns_boardId_mondayColumnId_key" ON "monday_ghost_columns"("boardId", "mondayColumnId");

-- CreateIndex
CREATE INDEX "monday_ghost_items_boardId_idx" ON "monday_ghost_items"("boardId");

-- CreateIndex
CREATE INDEX "monday_ghost_items_name_idx" ON "monday_ghost_items"("name");

-- CreateIndex
CREATE UNIQUE INDEX "monday_ghost_items_boardId_mondayItemId_key" ON "monday_ghost_items"("boardId", "mondayItemId");

-- CreateIndex
CREATE INDEX "monday_ghost_dropdown_options_boardColumnId_idx" ON "monday_ghost_dropdown_options"("boardColumnId");

-- CreateIndex
CREATE INDEX "monday_ghost_dropdown_options_label_idx" ON "monday_ghost_dropdown_options"("label");

-- CreateIndex
CREATE UNIQUE INDEX "monday_ghost_dropdown_options_boardColumnId_optionId_key" ON "monday_ghost_dropdown_options"("boardColumnId", "optionId");

-- AddForeignKey
ALTER TABLE "monday_ghost_columns" ADD CONSTRAINT "monday_ghost_columns_boardId_fkey" FOREIGN KEY ("boardId") REFERENCES "monday_ghost_boards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "monday_ghost_items" ADD CONSTRAINT "monday_ghost_items_boardId_fkey" FOREIGN KEY ("boardId") REFERENCES "monday_ghost_boards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "monday_ghost_dropdown_options" ADD CONSTRAINT "monday_ghost_dropdown_options_boardColumnId_fkey" FOREIGN KEY ("boardColumnId") REFERENCES "monday_ghost_columns"("id") ON DELETE CASCADE ON UPDATE CASCADE;
