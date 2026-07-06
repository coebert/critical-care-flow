import { test, expect } from "@playwright/test";

/**
 * Sidebar active-state highlighting.
 *
 * The Analytics NavItem must highlight ONLY when the current route is
 * exactly `/analytics`. Visiting `/postop-bookings` (a sibling route)
 * must never mark Analytics active. TanStack Router applies the CSS
 * class `active` to `<Link>` when its `to` matches per `activeOptions`;
 * our NavItems use `exact: true`.
 */

const analyticsLink = (page: import("@playwright/test").Page) =>
  page.getByRole("link", { name: /^Analytics$/ });

const postopLink = (page: import("@playwright/test").Page) =>
  page.getByRole("link", { name: /^Post-op bookings$/ });

test.describe("sidebar active route highlighting", () => {
  test("Analytics is active on /analytics and not on /postop-bookings", async ({ page }) => {
    await page.goto("/analytics");
    await expect(analyticsLink(page)).toHaveClass(/(^|\s)active(\s|$)/);
    await expect(postopLink(page)).not.toHaveClass(/(^|\s)active(\s|$)/);

    await page.goto("/postop-bookings");
    await expect(postopLink(page)).toHaveClass(/(^|\s)active(\s|$)/);
    await expect(analyticsLink(page)).not.toHaveClass(/(^|\s)active(\s|$)/);
  });
});
