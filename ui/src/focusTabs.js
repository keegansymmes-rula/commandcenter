// The tab bar's contents and order, kept out of FocusBoard.jsx so the order
// can be pinned by a test. The supervisor tab's label is its configured name
// (PEARL_NAME, delivered with the tickets response), never a literal.
export function focusTabs(pearlName) {
  return [
    { id: "tickets", label: "Tickets" },
    { id: "todos", label: "Todos" },
    { id: "prs", label: "Pull Requests" },
    { id: "reviews", label: "Review Requests" },
    { id: "pearl", label: pearlName },
  ];
}
