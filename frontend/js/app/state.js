/** List filters. They live here, not in the page, so they survive a visit to a detail page. */
export const filters = {
  gaps: { status: "", owner: "", overdue: false },
  circulars: { source: "", status: "active", q: "" },
  policies: { q: "" },
};
