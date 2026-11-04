# P3 · ED-12 checklist: every control on today's screens, and where it lives now

Owner: P3-INSPECTOR. Requirement ED-12 ("each thing a founder can change on today's screen for that type can be changed in the form, from a checked list").

This list is checked by `scripts/test-editor-inspector.js` ("the ED-12 checklist lists every legacy control…"):

- The test scans the legacy screens below for every control element (`Input`, `Textarea`, `Select`, `Switch`, `Button`, `IconButton`, `ManualAdd`, `CollectionPicker`, `ProductPicker`, `ConfirmDialog`, `ConflictBanner`, and plain `input`, `select`, `textarea`, `button`). Each one must be cited by a row here (`file:line`), and each row must cite one of them. The legacy files are untouched by phase 3, so the line numbers hold.
- A `field` row must name a field the new forms really have: `<document type or section kind>: <path>`, checked against `inspectorModel.formOf`. Paths use the stored names: `N` is an item's place in a list.
- A `waits` row must name what it waits for.

Scanned: `NavigationEditor` (whole file: the announcement bar, header and footer menus), `HomeEditor` (the collections index card, its typed-add and picker, and the card actions it shares), `PdpExtrasEditor` (whole file), `SurfaceTemplatesCard` (whole file), the announcement part of the `Designer` inspector (lines 855 to 886), and, for TOK-03, `BrandAdmin` and `ThemeAdmin` (whole files).

## Statuses

| Status | Meaning |
|---|---|
| `field` | A field of the new form (this item: `SettingsForm`, `MenuControl`, `DesignForm`). |
| `tree` | A section list action: add, move, hide or show, duplicate, remove (P3-TREE). |
| `shell` | Saving, conflicts, history, going back to the live version or publishing. The new editor does these for every document at once (P3-STORE autosave and conflict choice, P3-EDITOR "Go back to the live version", P3-PUBLISHUI earlier versions and publish). |
| `elsewhere` | Another phase 3 item owns it (named). |
| `waits` | Not editable in phase 3; the row says what it waits for. |

## The list

| Legacy control | What it does | Status | New field | Note |
|---|---|---|---|---|
| `components/admin/cms/NavigationEditor.js:96` | Reset to default (announcement, header or footer card) | shell | P3-EDITOR "Go back to the live version" (discardDraft) | The menu's own default is the Automatic mode (header: mode) and the bar's is off (announcement: enabled). |
| `components/admin/cms/NavigationEditor.js:96` | Reset a menu to its automatic default | field | header: mode | Choosing Automatic is the default menu; the items are kept, with a note, rather than thrown away. Same field on the footer. |
| `components/admin/cms/NavigationEditor.js:100` | Save the card | shell | P3-STORE autosave | No Save button: edits save after one pause. |
| `components/admin/cms/NavigationEditor.js:108` | Someone else saved: take theirs or overwrite | shell | P3-STORE conflict choice (Use the newer version, Keep mine) | Neither version is lost: the other is kept as an earlier draft. |
| `components/admin/cms/NavigationEditor.js:119` | Confirm the reset | shell | P3-EDITOR "Go back to the live version" confirm | |
| `components/admin/cms/NavigationEditor.js:159` | Show the announcement bar | field | announcement: enabled | |
| `components/admin/cms/NavigationEditor.js:163` | The bar's text (up to 200 characters) | field | announcement: text | The limit is reported, not cut; over 90 characters a note says it may wrap on phones. |
| `components/admin/cms/NavigationEditor.js:166` | The bar's link (a path, an anchor or a full https address) | field | announcement: link | Typed link: a collection, a product, one of your pages, or an address on the store. A link to another site is reported (LINK_NOT_STOREFRONT) where the legacy screen let it save. |
| `components/admin/cms/NavigationEditor.js:211` | A menu item's or sub-item's label | field | header: items.N.label, items.N.children.N.label | Same on the footer (footer: items). |
| `components/admin/cms/NavigationEditor.js:219` | A menu item's or sub-item's link | field | header: items.N.link, items.N.children.N.link | Typed link, as for the bar. A bad menu link saves as unfinished in a draft and blocks publishing. |
| `components/admin/cms/NavigationEditor.js:229` | Move an item or sub-item up | field | header: items | MenuControl move up (inspectorModel menu.move). |
| `components/admin/cms/NavigationEditor.js:230` | Move an item or sub-item down | field | header: items | MenuControl move down. |
| `components/admin/cms/NavigationEditor.js:231` | Remove an item (with its sub-items) or a sub-item | field | header: items | MenuControl remove (menu.remove). |
| `components/admin/cms/NavigationEditor.js:262` | Automatic menu (header: every collection A to Z) | field | header: mode | "Automatic: every collection, A to Z". |
| `components/admin/cms/NavigationEditor.js:262` | Automatic menu (footer: top 5 collections) | field | footer: mode | "Automatic: your top 5 collections". |
| `components/admin/cms/NavigationEditor.js:265` | Custom menu | field | header: mode | Same on the footer (footer: mode). |
| `components/admin/cms/NavigationEditor.js:312` | Add a sub-item (up to 8) | field | header: items.N.children | menu.addChild, disabled at 8. |
| `components/admin/cms/NavigationEditor.js:325` | Add an item (up to 12) | field | header: items | menu.add, disabled at 12. |
| `components/admin/cms/NavigationEditor.js:325` | Add a footer item (up to 12) | field | footer: items | |
| `components/admin/cms/HomeEditor.js:130` | Type a collection's web name into a list (not yet synced) | field | collections_index: featured, order, hide | The list control offers a typed add when the editor passes no catalog list. |
| `components/admin/cms/HomeEditor.js:145` | Add the typed collection | field | collections_index: featured, order, hide | |
| `components/admin/cms/HomeEditor.js:281` | Reset the collections curation to default | shell | P3-EDITOR "Go back to the live version" | Emptying all three lists is the automatic default. |
| `components/admin/cms/HomeEditor.js:285` | Save the card | shell | P3-STORE autosave | |
| `components/admin/cms/HomeEditor.js:292` | Someone else saved: take theirs or overwrite | shell | P3-STORE conflict choice | |
| `components/admin/cms/HomeEditor.js:399` | Choose collections… for a list (catalog picker) | field | collections_index: featured, order, hide | The list control's "Add a collection" picker, from the catalog rows the editor passes in, with each one's id kept. |
| `components/admin/cms/HomeEditor.js:611` | Automatic (from the catalog) | field | collections_index: featured, order, hide | All three lists empty renders exactly as automatic: the collections page shows every collection A to Z and the home row its default. There is no separate mode setting. |
| `components/admin/cms/HomeEditor.js:614` | Curated | field | collections_index: featured, order, hide | Curated is any list holding a collection. |
| `components/admin/cms/HomeEditor.js:646` | Remove from Featured | field | collections_index: featured | |
| `components/admin/cms/HomeEditor.js:652` | Typed add to Featured (up to 6) | field | collections_index: featured | The limit is reported, not cut. |
| `components/admin/cms/HomeEditor.js:668` | Move up in the order | field | collections_index: order | |
| `components/admin/cms/HomeEditor.js:669` | Move down in the order | field | collections_index: order | |
| `components/admin/cms/HomeEditor.js:675` | Remove from the order | field | collections_index: order | |
| `components/admin/cms/HomeEditor.js:681` | Typed add to the order (up to 50) | field | collections_index: order | |
| `components/admin/cms/HomeEditor.js:696` | Stop hiding a collection | field | collections_index: hide | A collection both shown and hidden is reported at the Hidden list (SHOWN_AND_HIDDEN). |
| `components/admin/cms/HomeEditor.js:702` | Typed add to Hidden (up to 50) | field | collections_index: hide | |
| `components/admin/cms/HomeEditor.js:726` | Confirm the reset | shell | P3-EDITOR "Go back to the live version" confirm | |
| `components/admin/cms/HomeEditor.js:739` | The collection picker dialog | field | collections_index: featured, order, hide | The new list control is a plain picker of the rows passed in (no dialog yet); P3-EDITOR passes the catalog. |
| `components/admin/cms/PdpExtrasEditor.js:104` | Reset the accordions to default | shell | P3-EDITOR "Go back to the live version" | |
| `components/admin/cms/PdpExtrasEditor.js:108` | Save | shell | P3-STORE autosave | |
| `components/admin/cms/PdpExtrasEditor.js:116` | Someone else saved | shell | P3-STORE conflict choice | |
| `components/admin/cms/PdpExtrasEditor.js:137` | An accordion's title | field | rich_text: title | Each accordion on every product page is a Rich text section of the product page layout (product_layout). Text and FAQ sections there become accordions too. |
| `components/admin/cms/PdpExtrasEditor.js:147` | Show or hide an accordion | tree | P3-TREE hide and show | Hidden keeps the content, as before. |
| `components/admin/cms/PdpExtrasEditor.js:155` | Move an accordion up | tree | P3-TREE move | |
| `components/admin/cms/PdpExtrasEditor.js:156` | Move an accordion down | tree | P3-TREE move | |
| `components/admin/cms/PdpExtrasEditor.js:162` | Duplicate an accordion | tree | P3-TREE duplicate | Fresh ids. |
| `components/admin/cms/PdpExtrasEditor.js:168` | Remove an accordion | tree | P3-TREE delete | |
| `components/admin/cms/PdpExtrasEditor.js:171` | An accordion's content (raw HTML) | field | rich_text: html | RichTextField (fallback text box here; P3-RTE ships the real editor behind the same props). |
| `components/admin/cms/PdpExtrasEditor.js:183` | Add an accordion (up to 8) | tree | P3-TREE add (Rich text on the product page layout) | The product page layout allows one section above the product details (maxBeforeProtected). |
| `components/admin/cms/PdpExtrasEditor.js:193` | Confirm removing an accordion | tree | P3-TREE delete | |
| `components/admin/cms/PdpExtrasEditor.js:202` | Confirm the reset | shell | P3-EDITOR "Go back to the live version" confirm | |
| `components/admin/cms/SurfaceTemplatesCard.js:171` | Save | shell | P3-STORE autosave | |
| `components/admin/cms/SurfaceTemplatesCard.js:177` | Someone else saved | shell | P3-STORE conflict choice | |
| `components/admin/cms/SurfaceTemplatesCard.js:195` | Product page template (Classic, Editorial) | field | product_layout: template | "Classic: two columns", "Editorial: story-led". |
| `components/admin/cms/SurfaceTemplatesCard.js:195` | Collection page template (Standard, Sidebar) | field | collection_layout: template | |
| `components/admin/cms/SurfaceTemplatesCard.js:195` | Header layout (Standard, Centered) | field | header: template | |
| `components/admin/cms/SurfaceTemplatesCard.js:195` | Footer layout (Columns, Minimal) | field | footer: template | |
| `components/admin/cms/SurfaceTemplatesCard.js:219` | A template exception for one product or collection | waits | Per-product layout: product content (OVL-02). Per-collection layout: collection content, which has no document type yet | |
| `components/admin/cms/SurfaceTemplatesCard.js:231` | Remove an exception | waits | As above: product content (OVL-02) and collection content (no type yet) | |
| `components/admin/cms/SurfaceTemplatesCard.js:240` | Add product or collection exceptions | waits | As above: product content (OVL-02) and collection content (no type yet) | |
| `components/admin/cms/Designer.js:866` | The announcement bar's history | shell | P3-PUBLISHUI earlier versions | |
| `components/admin/cms/Designer.js:869` | Show the bar | field | announcement: enabled | |
| `components/admin/cms/Designer.js:873` | The bar's text | field | announcement: text | |
| `components/admin/cms/Designer.js:882` | The bar's link | field | announcement: link | |
| `components/admin/BrandAdmin.js:39` | Colour picker (accent, background, text) | field | design: brand.accent, brand.background, brand.foreground | DesignForm keeps a picker beside each colour. |
| `components/admin/BrandAdmin.js:46` | Colour as #rrggbb (accent, background, text) | field | design: brand.accent, brand.background, brand.foreground | A half-typed colour shows a note; the button text colour on the accent is worked out again on each change. |
| `components/admin/BrandAdmin.js:186` | Corner radius | field | design: brand.radius | "Corners": Small, Medium, Large, Extra large. |
| `components/admin/BrandAdmin.js:195` | Type scale | field | design: brand.type_scale | "Text size". |
| `components/admin/BrandAdmin.js:204` | Button shape | field | design: brand.button_shape | |
| `components/admin/BrandAdmin.js:213` | Section spacing | field | design: brand.section_spacing | "Space between sections". |
| `components/admin/BrandAdmin.js:228` | The "Buy now" sample button (a preview, not a setting) | shell | P3-EDITOR preview pane | The preview beside the form shows the real store with the draft design (showDesign on while the design document is open). |
| `components/admin/BrandAdmin.js:240` | Save | shell | P3-STORE autosave | |
| `components/admin/BrandAdmin.js:243` | Reset to the platform default | field | design: brand | "Go back to the platform's default brand" (no brand stored). |
| `components/admin/BrandAdmin.js:249` | Confirm the reset | shell | P3-EDITOR "Go back to the live version" confirm | The reset itself is a draft change; publishing is the confirm. |
| `components/admin/ThemeAdmin.js:100` | Apply a kit (look, optionally its brand and hero words) | elsewhere | P3-DESIGN applyKit writes the design draft | |
| `components/admin/ThemeAdmin.js:100` | Pick the look alone | field | design: theme | DesignForm "Look": Pulse or Glow, from lib/brand.js KIT_SURFACES. |
| `components/admin/ThemeAdmin.js:121` | Cancel applying a kit | elsewhere | P3-DESIGN | |
| `components/admin/ThemeAdmin.js:124` | Confirm applying a kit | elsewhere | P3-DESIGN | |
| `components/admin/ThemeAdmin.js:137` | Also apply the kit's brand colours | elsewhere | P3-DESIGN applyKit (withBrand) | |
| `components/admin/ThemeAdmin.js:141` | Also replace the hero words with the kit's | elsewhere | P3-DESIGN applyKit (withPresets) | |

## Types that wait (phase 4 cutover gates, plan section 4)

- **Cart.** The form exists and edits everything today's cart slot can (UpsellsAdmin's cart drawer slot: the suggestions title as cart: title, the suggested products in order as cart: products). Who may change it waits for the owner's **capability ruling** (`upsells.write` or `storefront.*`, P2-PLAN section 3). The form shows that note.
- **Product content.** Per-product modules, badges and pairs (CatalogAdmin modules, UpsellsAdmin "pairs well with", per-product template exceptions) wait for **OVL-02**. The type is stored and its sections open in the section form, but it can't be published, and the form says so.
- **Collection content.** Per-collection template exceptions and anything else per collection wait for a **collection content document type**, which is not registered yet (P3-PLAN section 2: ED-12 lists `collection_content`, but no such type exists).

## Deliberate changes from the legacy screens

- Links are typed and stay on the store (a collection, a product, one of your pages, or an address on the store). A full `https://` link to another site, which the legacy menu and bar accepted, is now reported in plain words. It blocks publishing, and in a draft a menu link is kept as unfinished.
- Switching a menu to Automatic keeps its items (shoppers don't see them, and a note says so) where the legacy screen threw them away on save. A custom menu with no items shows no menu, and the form says so (the legacy screen saved it as Automatic).
- Text limits are reported, never cut: the legacy inputs stopped typing at the limit (`maxLength`).
- The collections index has no separate Automatic or Curated switch: empty lists are automatic.
- Product page accordions are Rich text sections (or Text and FAQ sections) of the product page layout, so they get the section list's actions rather than their own.
