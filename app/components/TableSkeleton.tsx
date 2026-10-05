import { Skeleton } from "@/components/ui/skeleton";
import { TableCell, TableRow } from "@/components/ui/table";

/**
 * Placeholder body rows for a table whose header is already on screen.
 *
 * The header names the columns before the first byte of data arrives, so the
 * table opens at its final shape and the page around it does not move when the
 * rows fill in — the whole point of drawing the frame up front. The bars step
 * down in width so the block reads as rows of text, not as one grey slab.
 */
export function SkeletonRows({ columns, rows = 5 }: { columns: number; rows?: number }) {
  return (
    <>
      {Array.from({ length: rows }, (_, row) => (
        <TableRow key={row}>
          {Array.from({ length: columns }, (_, column) => (
            <TableCell key={column}>
              <Skeleton className={column % 3 === 1 ? "h-4 w-16" : column % 3 === 2 ? "h-4 w-12" : "h-4 w-24"} />
            </TableCell>
          ))}
        </TableRow>
      ))}
    </>
  );
}
