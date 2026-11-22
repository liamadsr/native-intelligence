# Spreadsheets

A spreadsheet is a new kind of record in the app: a workbook of sheets with a formula
engine, formatting, import and export, and tools so agents can read and edit it. The target
is parity with the spreadsheets in Macro (`github.com/macro-inc/macro`), in this app's own
design.

Status of this file: the inventory and the plan. Each phase's report says what is done
against it.

## Licensing: how this was made

Macro is AGPL-3.0. None of its code, CSS, SVGs or assets is in this repository.

- **Clean room.** One reader read Macro's source and its guide for the spreadsheet block and
  wrote a description in plain prose: features, interactions, menus, shortcuts, layout,
  states, limits. No code, no CSS, no identifiers beyond public function names, key
  shortcuts and labels a person sees. Everything here is built from that description. The
  description was made from reading, not from running Macro.
- **Dependencies** are permissive only. Each one added is named with its license in
  "Dependencies" below.
- **Macro's own engine patches are not used.** Macro runs a patched copy of IronCalc. We use
  the upstream package from npm, unpatched. Two functions Macro added on top (AGGREGATE,
  GETPIVOTDATA) are therefore ours to write or to leave out; see "Formulas".

## What Macro has

How Macro does it, in one paragraph: a real editor, not a viewer and not an embedded grid
product. The grid is Macro's own. The formula engine is IronCalc (Rust compiled to
WebAssembly, MIT or Apache-2.0). Live editing is on Loro CRDTs (MIT). Number formats use
`ssf` (Apache-2.0). Calculated values are never stored: every reader recalculates. Limits:
100,000 rows by 16,384 columns a sheet, 300 sheets, 10,000 characters a cell; a new sheet
starts at 200 rows by 26 columns and grows.

Legend: **Has**, **Part** (limited, as described), **No**.

### The grid

| Item | Macro | Detail |
| --- | --- | --- |
| Cells and editing | Has | Click selects. Typing replaces. Double-click, Enter or F2 edits in place. The cell editor and the formula bar edit one draft. The editor takes the cell's fill, font and color. Enter commits and moves down, Tab commits and moves right, Escape cancels. A cell formatted as plain text keeps `=…` as text. |
| Selection | Has | One active cell and one rectangle. Arrows move, Shift extends, Home and Ctrl/Cmd jump, Ctrl/Cmd+A selects all. Drag selects. Header clicks select a row or column. The range tint leaves the active cell clear. |
| Several ranges at once | No | One rectangle only. |
| Fill handle | Part | Drag repeats the source and shifts relative formulas. Ctrl/Cmd+D fills down, Ctrl/Cmd+R fills right. It does not continue a series (1, 2, 3). |
| Copy and paste | Has | Inside the app: formats kept, relative references shifted. To and from Excel and Google Sheets through the system clipboard (tab-separated text and HTML). Paste, and Paste values only. A paste is one step. Text up to about 1 MB. |
| Undo and redo | Has | Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z. One action is one step. Other people's changes are not on your stack; an undo that would overwrite someone's later change is refused with a reason. |
| Freeze panes | No | Read from an imported file and kept, never drawn. No control to set one. |
| Resize | Has | Column width 8 to 640 px: drag, a Resize… box, Fit to data. Rows grow with wrapped text (to 160 px); no manual row height. |
| Hide and unhide | Has | Header menu: Hide, Unhide all rows or columns. |
| Insert and delete rows and columns | Has | Header menu: insert above or below, left or right; delete. Formulas that point at moved cells follow. Needs a live connection. |
| Merge cells | No | Kept from an imported file and when a range is moved. No command. |
| Find and replace | Has | Toolbar button and Ctrl/Cmd+F. |
| Move a range by its border | Has | Drag the selection's edge. Values, formats, notes and references follow; overwritten cells ask first; one undo step. |
| Sort a range | Has | A to Z, Z to A, whole rows inside the selection, relative formulas shifted. |

### Formulas

| Item | Macro | Detail |
| --- | --- | --- |
| Engine | Has | IronCalc in a web worker; only changed cells cross over. A time budget per calculation. |
| References | Has | `A1`, `$A$1`, mixed, `A1:B9`, `A:A`, `1:2`. |
| Other sheets | Has | `Sheet2!A1`, `'My Sheet'!A1`. Imported 3-D references are expanded. |
| Table references | Has | `Sales[Amount]`, `[@Qty]`, `Sales[[#Totals],[Amount]]`. |
| Error values | Has | `#REF!`, `#VALUE!`, `#N/A`, `#DIV/0!`, `#NAME?`, `#NUM!`, `#SPILL!` and the rest of Excel's set. |
| Function list | Has | 492 functions; the names are in "The function list" below. |
| Autocomplete | Has | A list of matching functions with their arguments, in the cell and in the formula bar. Inside a table, column names. |
| Pick a reference by pointing | Has | While typing a formula, click or drag on the grid to put the reference at the caret, on another sheet too. |
| Volatile functions | Part | NOW, TODAY, RAND, RANDBETWEEN, RANDARRAY give `#N/A` with a reason, so two readers never see different values. |
| Named ranges | Part | Names in an imported file work in formulas. No way to make or edit one. |
| Arrays that spill | Part | They calculate and show. The grid does not grow to make room. |

### Formatting

| Item | Macro | Detail |
| --- | --- | --- |
| Font and size | Has | Family menu; size box with smaller and larger. |
| Bold, italic, underline, strikethrough | Has | |
| Text color and fill | Has | Named palettes. |
| Borders | Has | Per edge. |
| Alignment | Has | Horizontal, vertical, indent in and out. |
| Wrap | Has | Rows grow. |
| Number formats | Has | Automatic, Number, Currency, Accounting, Percent, Scientific, Date, Time, Plain text. More and fewer decimals. One-click currency and percent. |
| Date formats | Has | Seven presets and a "Custom date and time…" box that takes any Excel code and previews it. A typed date becomes a date. A date cell opens a calendar. |
| Conditional formatting | Part | Rules in an imported file are kept and applied (value, formula, text, dates, blanks, errors, duplicates, top and bottom, above and below average, color scales, data bars, icon sets). No way to write a rule. |

### Data

| Item | Macro | Detail |
| --- | --- | --- |
| Sort | Has | A range; the whole sheet by a column from the column menu; a table column. |
| Filter | Part | Inside tables only: a condition and a searchable list of values per column. |
| Data validation | Has | Dropdown… makes a list from typed items or a range, can reject other values, colors per choice shown as chips. Imported rules (list, number, date, time, text length) are honored: stop refuses, warn and info accept. Alt+Down opens a list. |
| Checkboxes | Has | Insert checkbox; Space toggles. |
| Tables | Has | A named range with a header row and an optional total row. Convert to table (Ctrl/Cmd+Alt+T). Column types: text, number, percent, currency, date, date-time, time, checkbox, dropdown, people. Per column: sort, filter, group by with a summary. Total row: sum, average, count, filled, empty, unique, min, max. Typing under or beside it grows it. Ten header colors, banded rows and columns. Convert to range; delete. |
| Goal Seek | Has | Change one cell until a formula reaches a value. |
| Trim whitespace | Has | |

### Structure

| Item | Macro | Detail |
| --- | --- | --- |
| Sheets | Has | Add, rename, delete, duplicate, move left and right, drag to reorder, an overview of all sheets. Names unique without regard to case, 31 characters at most. The last visible sheet cannot be deleted. A sheet other formulas point at cannot be renamed or deleted. Tab colors come from imported files. |
| Named ranges | Part | As above. |
| Charts | Has | Insert a chart of the selection: column, bar, line, area, pie, doughnut, scatter, radar, bubble, stock, contour, histogram, waterfall, funnel, box and whisker, treemap, sunburst, pareto, pie of pie, bar of pie. Anchored to cells, follows the data, moves and resizes. An Edit chart box for type, title, legend, data. |
| Images | Has | PNG, JPEG, GIF, WebP, BMP, 2 MB each, 16 MB a workbook, anchored to cells. |
| Pivot tables | Part | Kept from an imported file with their last values. No way to build one. |

### Collaboration

| Item | Macro | Detail |
| --- | --- | --- |
| Live editing by several people | Has | Changes merge as they are made; you see where others are, per sheet. |
| Comments | Has | Threads on the selected cells (Ctrl/Cmd+Alt+M) with a reply count. They follow their cells. |
| Sharing | Has | The app's own permissions and share box. View-only stops every write. |
| Version history | Part | Whatever the app's documents have. Nothing made for spreadsheets. |

### Files

| Item | Macro | Detail |
| --- | --- | --- |
| Saving | Has | Continuous. No save button. |
| Import .xlsx | Has | Formulas, formats, widths and heights, hidden rows and columns, merges, tables, conditional formats, validation, notes, charts, images, pivot tables. What it cannot read becomes a warning in a preview, not a failure. About 50 MB. |
| Export .xlsx | Has | With the last calculated value beside every formula. |
| Import .csv | Has | At the active cell, quoted multi-line fields. |
| Export .csv | Has | Values of the active sheet. |

### The surroundings

| Item | Macro | Detail |
| --- | --- | --- |
| Layout, top to bottom | Has | Title bar with Share; one row of formatting controls; the formula bar with a Go to cell box at its left (can be hidden); column letters; the grid with row numbers (about four fifths of the height); a footer with the sheet tabs and an Import and export button pinned beside them. |
| Toolbar, left to right | Has | Font size smaller, size, larger. Bold, italic, strikethrough, underline. Undo, redo, currency, percent, fewer decimals, more decimals, indent out, indent in, wrap. Find and replace. Comment. Then menus: Number format, Font, Text color, Fill, Borders, Horizontal alignment, Vertical alignment, Functions (SUM, AVERAGE, COUNT, MIN, MAX), Paste special, Insert (chart, more charts, image, checkbox), View options (Gridlines, Formula bar, Formulas), Format and data (Sort range A to Z and Z to A, Trim whitespace, Dropdown…, Convert to table, Goal Seek…, Fill down, Fill right, Clear formatting, Clear values). |
| Formula bar | Has | Cancel and apply buttons while editing. |
| Go to cell | Has | |
| Cell menu | Has | Cut, Copy, Paste, Paste values only, Clear values, Clear formatting, Dropdown…, Insert or Remove checkbox, Convert to table or Table options, Comment. |
| Row and column menu | Has | Cut, Copy, Paste, Paste values only, Insert (above, below, left, right), Delete, Clear, Hide, Unhide all, Resize…, Fit to data, Sort sheet A to Z and Z to A. |
| Sheet tab menu | Has | Rename, Duplicate, Delete, Move left, Move right, Add sheet, Workbook sheets. |
| Sum, average and count of the selection | No | No status strip. |
| Zoom | Has | |
| Shortcuts | Has | Enter, Tab, Escape, F2, Delete and Backspace, Space, arrows with Shift, Home, End; Ctrl/Cmd with Z, Shift+Z, B, I, U, A, D, R, F, C, X, V; Ctrl/Cmd+Alt with T and M; Alt+Down. |
| Phone and narrow | Has | A compact header, touch editing, drag handles on the selection, the footer stays above the keyboard. |
| Read-only | Has | |
| Loading and errors | Has | A grid skeleton while loading. A failed calculation leaves editing and undo working and can be retried. |

### Agents in Macro

Three tools beside "create a document":

- **Read**: the sheets, their used ranges, counts of formulas and errors, tables and their
  columns, small samples; for given ranges the typed input, the formula, the calculated
  value, the text shown and optionally the style (about 500 cells). Returns a revision.
- **Calculate**: up to 20 formulas run against the workbook without writing, with optional
  "what if this cell were X" inputs.
- **Edit**: one batch, all or nothing, refused if the revision is stale. At most 25
  operations and 2,000 cells: set cells, format cells, clear cells, fill, append rows, resize
  columns, set a dropdown, clear validation, insert checkboxes, create a table, add, rename,
  duplicate and delete a sheet.

### The function list

Names by category (492 in Macro's catalog).

- **Math:** ABS, ACOS, ACOSH, ACOT, ACOTH, AGGREGATE, ARABIC, ASIN, ASINH, ATAN, ATAN2,
  ATANH, BASE, CEILING, CEILING.MATH, CEILING.PRECISE, COMBIN, COMBINA, COS, COSH, COT, COTH,
  CSC, CSCH, DECIMAL, DEGREES, EVEN, EXP, FACT, FACTDOUBLE, FLOOR, FLOOR.MATH,
  FLOOR.PRECISE, GCD, INT, ISO.CEILING, LCM, LN, LOG, LOG10, MDETERM, MINVERSE, MMULT, MOD,
  MROUND, MULTINOMIAL, MUNIT, ODD, PI, POWER, PRODUCT, QUOTIENT, RADIANS, RAND, RANDARRAY,
  RANDBETWEEN, ROMAN, ROUND, ROUNDDOWN, ROUNDUP, SEC, SECH, SERIESSUM, SIGN, SIN, SINH, SQRT,
  SQRTPI, SUBTOTAL, SUM, SUMIF, SUMIFS, SUMPRODUCT, SUMSQ, SUMX2MY2, SUMX2PY2, SUMXMY2, TAN,
  TANH, TRUNC.
- **Statistics:** AVEDEV, AVERAGE, AVERAGEA, AVERAGEIF, AVERAGEIFS, BETA.DIST, BETA.INV,
  BETADIST, BETAINV, BINOM.DIST, BINOM.DIST.RANGE, BINOM.INV, BINOMDIST, CHIDIST, CHIINV,
  CHISQ.DIST, CHISQ.DIST.RT, CHISQ.INV, CHISQ.INV.RT, CHISQ.TEST, CHITEST, CONFIDENCE,
  CONFIDENCE.NORM, CONFIDENCE.T, CORREL, COUNT, COUNTA, COUNTBLANK, COUNTIF, COUNTIFS, COVAR,
  COVARIANCE.P, COVARIANCE.S, CRITBINOM, DEVSQ, EXPON.DIST, EXPONDIST, F.DIST, F.DIST.RT,
  F.INV, F.INV.RT, F.TEST, FDIST, FINV, FISHER, FISHERINV, FORECAST, FORECAST.LINEAR,
  FREQUENCY, FTEST, GAMMA, GAMMA.DIST, GAMMA.INV, GAMMADIST, GAMMAINV, GAMMALN,
  GAMMALN.PRECISE, GAUSS, GEOMEAN, GROWTH, HARMEAN, HYPGEOM.DIST, HYPGEOMDIST, INTERCEPT,
  KURT, LARGE, LINEST, LOGEST, LOGINV, LOGNORM.DIST, LOGNORM.INV, LOGNORMDIST, MAX, MAXA,
  MAXIFS, MEDIAN, MIN, MINA, MINIFS, MODE, MODE.MULT, MODE.SNGL, NEGBINOM.DIST, NEGBINOMDIST,
  NORM.DIST, NORM.INV, NORM.S.DIST, NORM.S.INV, NORMDIST, NORMINV, NORMSDIST, NORMSINV,
  PEARSON, PERCENTILE, PERCENTILE.EXC, PERCENTILE.INC, PERCENTOF, PERCENTRANK,
  PERCENTRANK.EXC, PERCENTRANK.INC, PERMUT, PERMUTATIONA, PHI, POISSON, POISSON.DIST, PROB,
  QUARTILE, QUARTILE.EXC, QUARTILE.INC, RANK, RANK.AVG, RANK.EQ, RSQ, SKEW, SKEW.P, SLOPE,
  SMALL, STANDARDIZE, STDEV, STDEV.P, STDEV.S, STDEVA, STDEVP, STDEVPA, STEYX, T.DIST,
  T.DIST.2T, T.DIST.RT, T.INV, T.INV.2T, T.TEST, TDIST, TINV, TREND, TRIMMEAN, TTEST, VAR,
  VAR.P, VAR.S, VARA, VARP, VARPA, WEIBULL, WEIBULL.DIST, Z.TEST, ZTEST.
- **Financial:** ACCRINT, ACCRINTM, AMORDEGRC, AMORLINC, COUPDAYBS, COUPDAYS, COUPDAYSNC,
  COUPNCD, COUPNUM, COUPPCD, CUMIPMT, CUMPRINC, DB, DDB, DISC, DOLLAR, DOLLARDE, DOLLARFR,
  DURATION, EFFECT, FV, FVSCHEDULE, INTRATE, IPMT, IRR, ISPMT, MDURATION, MIRR, NOMINAL, NPER,
  NPV, ODDFPRICE, ODDFYIELD, ODDLPRICE, ODDLYIELD, PDURATION, PMT, PPMT, PRICE, PRICEDISC,
  PRICEMAT, PV, RATE, RECEIVED, RRI, SLN, SYD, TBILLEQ, TBILLPRICE, TBILLYIELD, VDB, XIRR,
  XNPV, YIELD, YIELDDISC, YIELDMAT.
- **Logical:** AND, FALSE, IF, IFERROR, IFNA, IFS, NOT, OR, SWITCH, TRUE, XOR.
- **Lookup:** ADDRESS, AREAS, CHOOSE, CHOOSECOLS, CHOOSEROWS, COLUMN, COLUMNS, DROP, EXPAND,
  FILTER, FORMULATEXT, GETPIVOTDATA, HLOOKUP, HSTACK, INDEX, INDIRECT, LOOKUP, MATCH, OFFSET,
  ROW, ROWS, SEQUENCE, SHEET, SHEETS, SORT, SORTBY, TAKE, TOCOL, TOROW, TRANSPOSE, TRIMRANGE,
  UNIQUE, VLOOKUP, VSTACK, WRAPCOLS, WRAPROWS, XLOOKUP, XMATCH.
- **Text:** ARRAYTOTEXT, ASC, CHAR, CLEAN, CODE, CONCAT, CONCATENATE, EXACT, FIND, FINDB,
  FIXED, LEFT, LEFTB, LEN, LENB, LOWER, MID, MIDB, NUMBERVALUE, PROPER, REGEXEXTRACT,
  REGEXREPLACE, REGEXTEST, REPLACE, REPLACEB, REPT, RIGHT, RIGHTB, SEARCH, SEARCHB,
  SUBSTITUTE, T, TEXT, TEXTAFTER, TEXTBEFORE, TEXTJOIN, TEXTSPLIT, TRIM, UNICHAR, UNICODE,
  UPPER, VALUE, VALUETOTEXT.
- **Date and time:** DATE, DATEDIF, DATEVALUE, DAY, DAYS, DAYS360, EDATE, EOMONTH, HOUR,
  ISOWEEKNUM, MINUTE, MONTH, NETWORKDAYS, NETWORKDAYS.INTL, NOW, SECOND, TIME, TIMEVALUE,
  TODAY, WEEKDAY, WEEKNUM, WORKDAY, WORKDAY.INTL, YEAR, YEARFRAC.
- **Database:** DAVERAGE, DCOUNT, DCOUNTA, DGET, DMAX, DMIN, DPRODUCT, DSTDEV, DSTDEVP, DSUM,
  DVAR, DVARP.
- **Engineering:** BESSELI, BESSELJ, BESSELK, BESSELY, BIN2DEC, BIN2HEX, BIN2OCT, BITAND,
  BITLSHIFT, BITOR, BITRSHIFT, BITXOR, COMPLEX, CONVERT, DEC2BIN, DEC2HEX, DEC2OCT, DELTA,
  ERF, ERF.PRECISE, ERFC, ERFC.PRECISE, GESTEP, HEX2BIN, HEX2DEC, HEX2OCT, IMABS, IMAGINARY,
  IMARGUMENT, IMCONJUGATE, IMCOS, IMCOSH, IMCOT, IMCSC, IMCSCH, IMDIV, IMEXP, IMLN, IMLOG10,
  IMLOG2, IMPOWER, IMPRODUCT, IMREAL, IMSEC, IMSECH, IMSIN, IMSINH, IMSQRT, IMSUB, IMSUM,
  IMTAN, OCT2BIN, OCT2DEC, OCT2HEX.
- **Information:** CELL, ERROR.TYPE, INFO, ISBLANK, ISERR, ISERROR, ISEVEN, ISFORMULA,
  ISLOGICAL, ISNA, ISNONTEXT, ISNUMBER, ISODD, ISOMITTED, ISREF, ISTEXT, N, NA, TYPE.
- **Lambda:** BYCOL, BYROW, LAMBDA, LET, MAKEARRAY, MAP, REDUCE, SCAN.

## How it fits this app

### The engine: decided

IronCalc, the upstream package `@ironcalc/wasm` 0.9.1 from npm (MIT or Apache-2.0), not
Macro's patched copy. It is the engine Macro's function list comes from, so parity on
functions is close to exact, and it carries far more than formulas: undo and redo, insert
and delete with reference rewriting, fill, copy and paste with shifted references, styles
and borders, number formats, merges, frozen panes, named ranges, conditional formatting,
sheets, a compact save format, and change sets one copy can send another.

Measured in this container on Node 24, before any app code: 20,000 rows with a formula each
filled and calculated in well under a second; the workbook saved as 373 KB and loaded in
5 ms; a formula on another sheet summing all 20,000 gave the right total.

Where upstream differs from Macro's copy (checked by running each):

- **AGGREGATE and GETPIVOTDATA are missing** (`#NAME?`): they are Macro's additions.
  AGGREGATE is to be covered; GETPIVOTDATA only means something with imported pivot tables.
- **NOW, TODAY and RAND calculate.** Macro blanks them to `#N/A`. To decide with live
  editing (phase 5); until then they work as in Excel.
- **A spill that has no room gives `#SPILL!`**, as in Excel.
- **Two answers that differ from Excel**, found while testing a sample of every category:
  XLOOKUP over an inline array (`{"a","b"}`) gives `#N/A` (over cells it is right), and
  TEXTJOIN told to ignore empties keeps a literal `""` argument (empty cells it does ignore).
  Both are the engine's; neither is patched here.
- **490 of the 492 names are known to the engine** (`functions.test.ts` runs every name
  through it). Known is not the same as proven equal to Excel in every corner.

The same engine runs in the browser (the editor) and on the server (the agents' tools,
import and export), so a tool's edit and a person's edit follow one set of rules.

### The record

- Tables `spreadsheet` (one row a workbook: title, visibility `workspace` or `private` as
  documents have it, workspace, the member who made it, the saved workbook, a revision
  number, the sheet names and a text digest for search, an archive mark) and
  `spreadsheet_revision` (version history, written by a trigger as documents' are).
  Row-level security with documents' rules: a member of the workspace reads a workspace
  one, only its maker reads a private one. **Migration 675**, new objects only.
- Saving sends the whole workbook with the revision it was loaded at. A stale revision is
  refused (documents' compare-and-swap), so one editor cannot silently overwrite another
  before live editing lands.
- The app already has **Tables** (rows under typed columns, with its own small formula
  language). A spreadsheet is a different thing (free cells, Excel formulas) and gets its
  own record; nothing of Tables changes. The existing grid component
  (`web/src/components/grid/cell-grid.tsx`) is read for its keyboard and glass conventions;
  a workbook needs row headers, a fill handle, formula pointing and merged cells, so the
  spreadsheet grid is its own component.

### Where it shows up

The app has no page routes for records: pages are cards. What "a page like a document"
takes here:

| Place | Files | Phase |
| --- | --- | --- |
| Create dialog | `lib/create/create-types.ts`, `components/create-dialog.tsx`, `components/create/quick-create.ts` | 1 |
| The kind itself | `lib/knowledge/entity-registry.ts`, `lib/entities/entity-actions-registry.ts` (open, rename, archive) | 1 |
| Page and card | `lib/chat-cards/page-menu.ts`, `pages.ts`, `page-server.ts`, `components/chat-cards/pages/`; the Drive group in the rail | 1 |
| Search | `lib/search/findable-registry.ts`, `app/api/account/search/menu-queries.ts`, `lib/search/menu-search.ts` | 1 |
| `@` picker | `lib/entity-links/mentionable.ts`; what an agent reads from a mention in `lib/ai/tool-discovery.ts` | 1, tools in 3 |
| Private ones stay private in the graph | `lib/knowledge/entity-fences.ts`, and a restrictive policy beside `entity_link`'s (migration 673's pattern, so the shared function is not restated) | 1 |
| Entity links (projects, actions) | `entity_link` has no list of kinds in the database; linkable comes from the registry | 3 |
| Agent tools | `lib/ai/tools/spreadsheets.ts`, a category in `lib/ai/tool-registry.ts`; MCP picks them up as `ni_*` by itself | 3 |
| Version history | `spreadsheet_revision` | 3 |
| Comments | See below | 3 and 5 |
| Sharing | See below | 3 |
| Icon and color | No `entity-identity` registry is on `main` yet. Icons go where they live today (create dialog, rail); the entry for that registry is listed in each report until it merges. | 1 |

Two places where "like a document" meets a rule of this work, for the owner to know:

- **Comments.** The app's comments name their kinds in a Postgres enum and in policies on
  `comment`; a test (`migration-674.test.ts`) refuses any later migration that adds a
  policy there, and a new enum value cannot be used in the transaction that adds it, which
  one migration number cannot do. Macro's comments are threads on cells anyway. So
  spreadsheet comments get their own table (thread, cell anchor, replies), beside the
  existing ones, with the same mention handling.
- **Sharing with one person.** Workspace or private works as for documents from phase 1.
  Granting one member, team or channel access to a private one (`entity_access`) means
  widening a check constraint and restating five shared functions that Tables' tests pin.
  That is "redefine", which this work was told not to do; it waits for the owner's word.
  Public share links exist only for captures and documents and are not planned.

### Where we go past Macro, and where we stop short

Past it, because the engine gives it and people expect it: freeze panes, merge cells, a
series from the fill handle, named ranges with an editor, conditional formatting with an
editor, the sum, average and count of the selection.

Not planned, said plainly: building pivot tables (Macro cannot either), SmartArt, shapes and
EMF/WMF pictures from imported files, the more exotic chart kinds until the common ones are
right.

## Phases

Each phase ends with the full test run, a push, and a report with screenshots.

1. **The record and the grid.** Migration 675, the API, the engine, a virtual
   grid tested at 10,000 rows and more, editing, selection, the formula bar with
   autocomplete and pointing, Go to cell, sheet tabs and their menu, undo and redo, copy and
   paste with Excel and Google Sheets, the fill handle, resize, hide, insert and delete,
   continuous saving, the create dialog, the list and page, search and the `@` picker.
2. **Formatting and the surroundings.** The whole toolbar, number and date formats, borders,
   colors, alignment, wrap, the three context menus, find and replace, sort, view options,
   every shortcut, phone and narrow layouts, read-only.
3. **Part of the app.** Import and export (.xlsx, .csv), the agents' three tools, entity
   links, comments, sharing, version history.
4. **Data and objects.** Dropdowns and validation, checkboxes, tables (typed columns,
   filter, group by, totals), conditional formatting, charts, images, Goal Seek.
5. **Together.** Live editing by several people and presence, comment threads on cells.

## Where it stands

### Phase 1: done

Against the inventory:

| Item | State |
| --- | --- |
| Cells and editing | Done. Type to replace; double-click, Enter or F2 to edit in place; one draft shared by the cell and the formula bar; Enter, Shift+Enter, Tab, Shift+Tab, Escape; Alt+Enter for a line break; F4 cycles a reference through `$`. The editor wears the cell's font, color and fill. |
| Selection | Done. Arrows, Shift, Ctrl/Cmd (edge of a block), Home, End, Page Up and Down, Ctrl/Cmd+A, drag, Shift+click, row and column headers (click, drag, Shift+click), the corner. The range tint leaves the active cell clear. |
| Fill handle | Done, and past Macro: it continues a series (1, 2 gives 3, 4). Ctrl/Cmd+D and Ctrl/Cmd+R. |
| Copy and paste | Done. Inside the app formats are kept and formulas shifted; a cut moves. To other apps: tab-separated text and an HTML table. From other apps: either. One cell pasted over a range fills it. A paste is one undo step. Tried in a browser with the real clipboard; not yet tried against Excel or Google Sheets themselves. |
| Undo and redo | Done. One action, one step (a 60,000-cell paste too). |
| Resize | Done. Drag a header's edge (all selected columns or rows together), double-click to fit, Resize… box, Fit to data. Rows too, which Macro has no control for. |
| Hide and unhide | Done, with a marker in the header where something is hidden. |
| Insert and delete rows and columns | Done. Formulas follow. |
| Sort a range, sort the sheet | Done from the menus. Formulas move as typed; their references are not rewritten (Macro shifts relative ones). |
| Formulas, references, other sheets, errors | Done (the engine). |
| Autocomplete | Done: matching functions with arrows, Tab or Enter; inside a function's brackets, its arguments with the current one in bold. Arguments and a line of help are written for 100 functions; the other 390 complete by name only. |
| Pointing | Done, on other sheets too. |
| Sheets | Done: add, rename (double-click, F2, menu), duplicate, delete, move left and right, drag to reorder, the list of all sheets. |
| Go to cell | Done: a cell, a range, a whole column or row, a cell on a named sheet. |
| Saving | Done: a little over a second after a change, against the revision loaded; a second editor's save is refused and they are offered the newer version. |
| Loading and errors | Done: a grid skeleton; a failed load or save can be tried again. |
| The record | Done: migration 675 (applied to the DEV project), the routes, visibility, archive, delete. |
| Create dialog, Drive in the rail, the page, search, the `@` picker, private ones fenced in the graph | Done. |

Decided along the way:

- **The engine runs on the page's own thread, not in a worker.** Macro uses a worker. Measured
  on a sheet of 10,000 rows with 20,000 formulas: a recalculation takes 12 ms and pasting
  60,000 cells 474 ms in a browser. A worker would make every read of a cell asynchronous for
  no gain at this size; it is the thing to revisit if recalculations reach a frame's length.
- **The headers are panes the size of the view**, with their letters and numbers moved under
  them, not strips as long as the sheet: a blurred strip 250,000 pixels tall cost about
  40 ms of every scrolled frame in a browser without a GPU.

Not done in phase 1, and where it goes:

- The full toolbar, number and date formats, borders, colors, alignment, find and replace,
  view options, the phone layout: phase 2. The toolbar has undo, redo, bold, italic,
  strikethrough and underline so far.
- Move a range by its border: phase 2.
- **History and the Recent feed.** The app's activity log needs triggers and a list of kinds
  in the database for each kind (migration 488's pattern); 675 has none, so a spreadsheet
  has no activity entries. It needs a migration number of its own.
- **Copy link.** The app's deep links (`/account?…`) know nothing of spreadsheets yet.
- **A mention gives an agent the spreadsheet's id only** until the tools of phase 3.
- **Icon and color:** the `entity-identity` registry is not on `main`. The icon (lucide
  `Sheet`) is set in the create dialog, the rail, the feed and the command menu; the entry
  to add when it merges is kind `spreadsheet`, icon `Sheet`.

## Dependencies

| Package | License | For |
| --- | --- | --- |
| `@ironcalc/wasm` 0.9.1 | MIT or Apache-2.0 | The engine. Its notices file lists no copyleft dependency. |

More are named here as they are added (a reader and writer for .xlsx in phase 3).
