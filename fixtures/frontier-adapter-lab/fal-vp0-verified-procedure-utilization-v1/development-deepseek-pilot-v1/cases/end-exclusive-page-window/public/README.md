# End-exclusive page windows

`pageWindow(pageIndex, pageSize, totalItems)` uses a zero-based page index and
returns a bounded half-open window. Full pages keep the requested size, a tail
page ends at the item count, and a page beginning at the count is empty.

Use the repository's executable verifier before treating a repair as complete.
