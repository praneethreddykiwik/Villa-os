import { pageContext } from "@/lib/page-context";
import { mutate } from "@/lib/db";
import { makeBoard } from "@/lib/board/templates";
import { TopBar } from "@/components/shell";
import { BoardView } from "@/components/board-view";

export const dynamic = "force-dynamic";

export default async function BoardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const { db, brand, brandId } = pageContext(sp);

  // A brand added after the seed still gets a board on first visit.
  let board = db.boards.find((b) => b.brandId === brandId);
  if (!board) {
    const created = makeBoard(brandId, `${brand.name} Board`);
    mutate((d) => void d.boards.push(created));
    board = created;
  }
  const cards = db.boardCards.filter((c) => c.boardId === board!.id);

  return (
    <>
      <TopBar brands={db.brands} brandId={brandId} title={board.name} subtitle={`${cards.length} cards · ${board.columns.length} columns`} />
      <BoardView board={board} cards={cards} />
    </>
  );
}
