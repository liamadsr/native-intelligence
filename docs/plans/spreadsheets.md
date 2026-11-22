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

- The full toolbar, number and date formats, borders, colors, alignment, find and replace and
  view options came in phase 2 (below).
- **History and the Recent feed.** The app's activity log needs triggers and a list of kinds
  in the database for each kind (migration 488's pattern); 675 has none, so a spreadsheet
  has no activity entries. It needs a migration number of its own.
- **Copy link.** The app's deep links (`/account?…`) know nothing of spreadsheets yet.
- **A mention gives an agent the spreadsheet's id only** until the tools of phase 3.
- **Icon and color:** the `entity-identity` registry is not on `main`. The icon (lucide
  `Sheet`) is set in the create dialog, the rail, the feed and the command menu; the entry
  to add when it merges is kind `spreadsheet`, icon `Sheet`.

### Phase 2: done

| Item | State |
| --- | --- |
| The toolbar | Done, in Macro's order: font size (smaller, the size, larger); bold, italic, strikethrough, underline; undo, redo, currency, percent, fewer and more decimal places, wrap; find and replace; then the menus Number format, Font, Text color, Fill color, Borders, Horizontal alignment, Vertical alignment, Functions, Paste special, View options, Format and data. It fits a card 946 px wide and scrolls sideways on a narrower one. |
| Number formats | Done: Automatic, Number, Currency, Accounting, Percent, Scientific, Time, Plain text, with what each looks like beside its name. A plain-text cell keeps a formula and leading zeros as typed. |
| Date formats | Done: the seven presets, and "Custom date and time…" with any Excel code and a live preview drawn by the engine itself. |
| Font and size | Done. Eight fonts every machine has, so two readers see the same sheet. |
| Text color and fill | Done: 25 named colors. Text on a fill with no color of its own is dark on a light fill and white on a dark one, in either theme. |
| Borders | Done: all, inside, outside, each edge, the two inner directions, none, and a thick outside. |
| Alignment and wrap | Done: automatic, left, center, right; top, middle, bottom; wrap. |
| Functions menu | Done: SUM, AVERAGE, COUNT, MIN, MAX. Over a selection it writes the formula under each column (or beside a single row); on one cell it starts the formula for pointing. |
| Paste special | Done: Paste, Paste values only. |
| View options | Done: Gridlines (kept with the workbook, per sheet), Formula bar, Formulas. |
| Format and data | Sort range A to Z and Z to A, Trim whitespace, Fill down, Fill right, Clear formatting, Clear values. Dropdown…, Convert to table and Goal Seek… are phase 4. |
| Find and replace | Done: Ctrl/Cmd+F or the toolbar; the count, next and previous (Enter, Shift+Enter), match case, whole cell, search formulas, Replace and Replace all (one undo step). It searches the sheet in view. |

Not in phase 2, said plainly:

- **Indent in and out.** The engine's cell style has no indent, so there is nothing to store it in. It would be this app's own addition (in `extras`), drawn by the grid and lost on export.
- **Move a range by dragging its border.** Cut and paste does the same job; the drag is not built.
- **A layout of its own for phones.** The editor works at any width (the toolbar scrolls sideways), and touch scrolls and taps select, but there are no drag handles on the selection and the footer does not follow the on-screen keyboard. Not tried on a phone.
- **The Insert and Comment controls** of Macro's toolbar come with what they insert: phases 4 and 5.

### Phase 3: done

| Item | State |
| --- | --- |
| Export .xlsx | Done, from the footer's Import and export button (in the browser, on the open workbook) and from `GET /api/account/spreadsheets/[id]/export?format=xlsx`. Every sheet with its name, hidden state and tab color; numbers, text, booleans, errors; formulas with their last calculated value beside them; fonts, fills, borders, alignment, wrap, number formats; column widths, row heights, hidden rows and columns, merges, frozen panes, gridlines, defined names. A file it wrote was opened with openpyxl and with LibreOffice: both read the values, formulas, formats and layout. Not opened in Excel itself. |
| Import .xlsx | Done: a new spreadsheet from a file (`POST /api/account/spreadsheets/import`). Reads all of the above back, shared formulas (expanded to each cell), the 1904 date system and theme colors. What it cannot carry is listed as warnings after the import, never a failure: charts, images, pivot tables, conditional formatting, data validation, notes, tables (a formula using `Table[Column]` shows `#NAME?`), external links, macros. Limits: 50 MB a file, 400 MB unpacked, 300 sheets, 100,000 rows, 16,384 columns (more is cut, with a warning). |
| Export .csv | Done: the sheet in view, the values it shows, quoted by RFC 4180. |
| Import .csv | Done: pasted at the active cell as one undo step, as Macro does; commas, semicolons or tabs; quoted fields with line breaks. |
| Agents | Done, five tools in a Spreadsheets category (so also `ni_*` over MCP): `find_spreadsheets`, `read_spreadsheet` (a summary, or exact ranges up to 500 cells, with the revision), `calculate_spreadsheet` (up to 20 formulas with what-if inputs on a throwaway copy; nothing is written), `create_spreadsheet`, `edit_spreadsheet` (one batch, all or nothing, refused when the revision is stale; 25 operations and 2,000 cells at most; cells it wrote that show an error come back as warnings). A private spreadsheet of someone else is "not found" to a tool. Writes are kept out of team chat, as Tables' are. A mention of a spreadsheet now tells the agent to read it. No model call was added: the tools run through the existing registry and eve's tool proxy. Not yet tried with a live agent turn. |
| Version history | Done: a History button in the title bar lists who changed it and when (an agent's change is marked), and restores a version as an ordinary save, so nothing is lost. One person's run of saves within ten minutes is one entry. |
| Entity links | A spreadsheet is linkable in the entity registry since phase 1, and private ones are fenced. The side panel that shows a record's links is not on the spreadsheet's card yet. |

**Migration 683** came with the tools: a new tool category would have silently narrowed every
agent persona saved with "all categories on" (the app's rule, migrations 538, 623, 632), so
683 gives those personas the `spreadsheets` category and leaves a narrowed one alone. The
committed file was applied to a local Postgres 16 several times: two every-category personas
gained it with their other settings kept; a narrowed one, one with disabled tools and a
non-agent row were untouched; a re-run changed nothing. Not applied to DEV or production.

Not done: comments (phase 5, with the threads on cells), sharing with one person (decision 5),
the activity log and copy link (they need database triggers and deep-link handling).

### Phase 4 (first part): done

Dropdowns and validation, checkboxes, conditional formatting and Goal Seek. Tables (typed
columns, filter, group by, totals), charts and images are the rest of phase 4 and are **not**
in this part.

| Item | State |
| --- | --- |
| Extras foundation | Done. A typed, versioned `WorkbookExtras` (`lib/spreadsheets/extras.ts`: `{ v: 1, validations, checkboxes, charts, images, tables }`, a tolerant `readExtras` that drops what it does not understand and a 1 MB size guard) is held by the controller and changed only through `act`, so a change to the extras is ONE undo step together with any engine change in the same action (the undo stack carries an extras before/after beside the engine step count; undo and redo restore both). It is in `snapshot()` and bumps `dataVersion`. Ranges are keyed by the engine's stable `sheet_id`, never an index or name. `shiftExtras` moves them when rows or columns are inserted or deleted and when a sheet is deleted or duplicated (shift, shrink or drop), wired into those controller methods. The editor loads `record.extras` into the controller and sends `extras` with a save only when they changed; an agent's save (which sends no extras) leaves the record's extras untouched. |
| Data validation — dropdowns | Done. "Dropdown…" from Format and data and from the cell menu opens a dialog: the range (prefilled from the selection), choices typed one per line OR a source range (`Sheet1!A2:A20`, read live, deduped), "Reject other values" (default on), and a palette color per choice shown as a chip in the cell. A cell has one rule; a new rule carves its range out of overlapping ones. A list cell draws a dropdown arrow; clicking it or Alt+Down opens a listbox (arrow keys, Enter, Escape, type-to-filter); choosing writes the value as one undo step. A rejecting rule refuses a typed value not in the list with a sentence (the cell keeps its old value); a non-rejecting rule accepts it and shows a warning corner with a tooltip. "Remove dropdown" / clear validation from the menus. |
| Data validation — other kinds | Done in the model and enforcement (for imports later), not in the dialog: number, date and text-length rules (min/max, between, equal, and the rest). A typed value is pre-checked; a formula is not (its result is not known until it calculates). Number and text-length enforce exactly; a date rule compares the cell's displayed value as a number, which is best-effort. |
| Paste and fill | Done. Both go through the same rejecting-rule check: a paste or a fill that would put a forbidden value in a rejecting cell is refused whole, naming the first bad cell, and nothing is written. |
| Checkboxes | Done. Insert checkbox / Remove checkbox from the cell menu and a new "Insert" toolbar menu (between Paste special and View options, "Checkbox" for now). A blank becomes FALSE; a checkbox cell draws a centered box (checked for TRUE) instead of its text; a click or Space on the active cell toggles TRUE/FALSE as one undo step; the value is a real boolean in formulas. Which cells are checkboxes is stored in extras (ranges per sheet) and follows the same shift rules. |
| Conditional formatting — drawing | Done. The grid draws what the engine computes: the winning rule's `style` (verified by a test), the `data_bar` (a bar behind the value, positive/negative colors, respecting show_value) and the `icon` (the 20 kinds as small lucide/CSS glyphs — our own drawings) in `cell-view.ts` and `sheet-grid.tsx`. |
| Conditional formatting — editor | Done, and past Macro (which only keeps imported rules; the plan allows this). A side panel (Format and data → "Conditional formatting…") lists the sheet's rules in priority order with their range and a plain description, and adds, edits, deletes and reorders them, for: cell value (greater than, less than, between, equal, not equal), text contains / starts with / ends with, is blank / not blank, is an error, duplicate / unique values, above / below average, a custom formula, and a 2- or 3-color scale. The format is fill color, text color, bold and italic. All through the engine's own calls, each one undo step. |
| Goal Seek | Done. Format and data → "Goal Seek…": Set cell (prefilled with the active cell), To value, By changing cell. The search (`lib/spreadsheets/goal-seek.ts`, a pure function) is a secant step then a bracketing bisection, run on a throwaway copy of the model read through a scratch cell, never on the open workbook. It shows the result ("B2 = 1,250 makes D9 = 5,000") or says plainly it found none; Apply writes the found value as one undo step. A quadratic with two roots finds whichever it brackets first; a non-numeric set cell is refused. |

Not in this part, said plainly: tables (typed columns, filter, group by, totals), charts and
images. They are the rest of phase 4.

### Phase 4 (second part): done

Tables, charts and images. All three live in `extras` (keyed by `sheet_id`, shifted by
`shiftExtras`, read tolerantly), change through the controller's `act` as one undo step, and
draw as overlays/floating objects in the grid without writing cell formats into the engine.

| Item | State |
| --- | --- |
| Tables — model | Done. `WorkbookTable` in extras: `{ id, sheet (sheet_id), name (unique identifier, Table1…), range (header + data [+ total]), columns [{ name, type, total? }], style { color (one of ten), bandedRows, bandedColumns, boldFirstColumn, boldLastColumn, totalRow }, filters (per column), sort?, hiddenRows? }`. `shiftExtras` moves a table's range on row/column inserts and deletes, adds a "Column N" when a column is inserted inside it and drops columns deleted from inside it, copies it on a sheet duplicate and drops it on a sheet delete. |
| Tables — convert | Done. Format and data → "Convert to table", the cell menu, and Ctrl/Cmd+Alt+T. A single cell converts the contiguous filled block around it; an empty cell makes a blank four-column table (headers Column 1..4, three empty rows); each column takes the type its values suggest (checkbox/date/percent/currency/number/text). Inside a table the same entries read "Table options". |
| Tables — drawing | Done, as an overlay: the header row in the table's color with white bold labels and a per-header menu arrow; banded rows and banded columns as soft tints; the table outline; a total-row divider. Nothing is written into the engine's cell styles. |
| Tables — column menu | Done: sort A→Z / Z→A (through the controller, one undo step, reusing the range sorter), filter (a condition: equals / does not equal / contains / greater than / less than / is empty / is not empty; and a searchable checklist of the column's distinct shown values), clear filter, column type, insert column left/right, delete column, rename (edits the header cell), group by. Filtering hides rows with `setRowsHidden` (so SUBTOTAL leaves them out) and remembers which rows the table hid, so "clear filters" unhides only those; a filtered column shows a dot on its arrow. |
| Tables — total row | Done. Each column offers sum/average/count numbers/count filled/count empty/count unique/min/max/none, written as `SUBTOTAL` (109/101/102/103/104/105), `COUNTBLANK` or `COUNTA(UNIQUE(…))`, so hidden rows are excluded (except the unique count, which counts across hidden rows too). |
| Tables — growth | Done. Typing in the row directly under a table (when it has no total row) extends it by that row; typing in the column directly right of it adds a column (header "Column N", or the text just typed if it was typed into the header row). A new row of a checkbox column becomes a checkbox; of a dropdown column, inherits the column's list validation. One undo step with the cell write. |
| Tables — options panel | Done (Format and data / the menus → "Table options…"): rename, change range (validated, columns padded/trimmed), color (ten swatches), the five toggles, clear filters, Convert to range (writes the header fill, white bold header text, banded-row fills and bold total into the cells, then drops the table — keeps the look), Delete table (clears the cells and removes it). |
| Tables — structured references | Done. A pure translator (`lib/spreadsheets/table-refs.ts`) rewrites `Sales[Amount]`, `[@Qty]`, `Sales[[#Totals],[Amount]]`, `Sales[#All]`/`[#Data]`/`[#Headers]` and a bare `Sales` to plain A1 before the engine sees them, in the controller's `setCell` path; a missing table or column becomes `#REF!`. The cell then stores the A1 form (decision 20). |
| Tables — group by | Done. A read-only popover from the column menu: pick a column to summarise and an aggregate (sum/average/count/min/max); a small table of group → value, computed in JS from the shown values. |
| Charts | Done. Insert → "Chart" makes a chart of the selection (first row = series names when text, first column = categories when text). Types, drawn as our own SVG (no library): column, bar, line, area, pie, doughnut, scatter. Stored in extras `{ id, sheet, type, title, legend, source (a range that follows shiftExtras), anchor { row, column, dx, dy }, width, height }`. A chart floats over the grid, scrolls with the sheet, is selectable, draggable to move and resizable by its corner; Delete (key or the handle's button) removes it; all undo steps. It re-reads its range's calculated values on every data change. "Edit chart" dialog: type, title, legend, data range. Axes use a `niceTicks` helper (tested), value labels are compact, colors come from a fixed accessible palette that reads on dark and light, a legend, and a quiet "No numbers in this range" for empty/invalid data. Pure preparation (range → series/categories/scales/pie angles) is in `lib/spreadsheets/charts.ts` with thorough tests; the SVG is in `components/spreadsheets/charts/`. |
| Images | Done. Insert → "Image…" picks a PNG, JPEG, GIF or WebP, validated by its magic bytes, not its name (SVG and anything else refused with a sentence); stored in extras as a data URL (the lead's decision, no bucket — decision 19), one blob per content hash so identical images are stored once; caps 1 MB an image and 4 MB a workbook, refused with a sentence. Anchored to the active cell, floating like a chart (move, resize keeping aspect ratio, delete, undo). |
| Agents and extras | The agents' tool file (`lib/ai/tools/spreadsheets.ts`) is unchanged and keeps a record's extras: it saves only the workbook, and `saveSpreadsheet` leaves `extras` untouched when none is passed. |

Not built in this part, said plainly:

- **Bold first/last column** is stored and offered, but drawn only as a faint banded tint, not as
  actual bold text (the overlay does not re-draw cell text). Convert to range does not bake it either.
- **The other chart kinds** Macro lists — radar, bubble, stock, contour, histogram, waterfall,
  funnel, box and whisker, treemap, sunburst, pareto, pie of pie, bar of pie — are **not** here;
  only the seven common ones are.
- **Import of tables, charts and images from .xlsx is unchanged**: the reader still only warns about
  them (phase 3). Export does not write them either.
- **An agent edit that inserts or deletes rows/columns does not shift a table's, chart's or image's
  stored ranges** (the tools write the engine model directly, bypassing `shiftExtras`), the same as
  for validation and checkboxes in the first part. A person's edits do shift them.
- **Chart tooltips** are not drawn (the plan left them optional).

### Phase 5: done

Comment threads on cells, and several people editing one spreadsheet merged through the
save path. Presence is **not** built (see below).

| Item | State |
| --- | --- |
| Comments on cells | Done. A thread is anchored to a cell range (the engine's stable `sheet_id` + an A1 range). "Comment" in the cell menu, a Comment button in the toolbar after Find and replace, and Ctrl/Cmd+Alt+M open a card beside the selected cell(s) to write the first comment. A cell with an open thread shows a small corner marker (resolved threads: none); clicking it, or the shortcut on that cell, opens the thread: each comment with author and relative time, a reply box (Enter sends, Shift+Enter a new line), reply count, Resolve / Reopen, and edit and delete on one's own comments. A "Comments" header button (beside Version history, badged with the count of open threads) opens a side panel listing every thread grouped by sheet, open first, with a toggle to show resolved ones; choosing one goes to its cell (switching sheet). Stored in `spreadsheet_comment` (675); `lib/spreadsheets/comments.ts` and the routes under `/api/account/spreadsheets/[id]/comments`, with `requireWorkspaceMember`, the member's display name on each comment, the caller's own client (RLS decides), 404 for a spreadsheet the caller cannot read. |
| Comments — mentions | Stored, **not** notified. The `mentions` column takes the mentioned member ids (validated UUIDs), but a mention does NOT notify or share: the app's comment-mention machinery is written for the `comment` table's kinds (`CommentableType` has no `spreadsheet`) and its sharing path grants per-person access, which a spreadsheet does not have (decision 5). Said plainly, not faked (decision 25). |
| Comments — anchors follow cells | Done. Inserting or deleting rows or columns in this editor shifts the anchors of that sheet's threads (reusing `shiftCommentAnchor` over the extras range-shift helpers) and saves the changed ones; undo of the structural edit moves them back (the controller emits the inverse change). A thread whose cells were deleted keeps living, shown as "its cells were deleted". A sheet delete marks its threads the same way (its undo does not restore them — decision 27). Comments are otherwise not part of undo history. |
| Editing together — merge on a conflict | Done, replacing the old lose-your-work answer (decision 7, 26). A save refused with 409 loads the newer workbook, replays this editor's unsaved actions onto it with the engine's change sets (`lib/spreadsheets/sync.ts` + the controller's `pendingDiffs()`/`adopt()`), adopts the merged workbook keeping the active sheet (by id), the selection and any open cell edit, and saves again against the new revision (bounded retries, then the existing "Not saved / Try again"). `WorkbookExtras` merge per top-level kind: theirs for kinds I did not touch, mine for the kinds I did. |
| Editing together — polling | Done. Every ~4 s while the tab is visible (paused when hidden, resumed at once on `visibilitychange`) the editor asks a new cheap route `GET /api/account/spreadsheets/[id]/revision` (`{ revision, last_edited_by, updated_at, editor_name }`). When it is ahead of mine: with nothing pending I fetch and adopt their workbook (selection, sheet and any open draft kept); with pending work I rebase and save. A quiet "Updated by <name>" shows for a few seconds. |
| Presence (who else has it open) | **NOT built, on purpose** (decision 24). The only presence the app has is global app-presence (`lib/presence`, `user_presence`: "is this person at a Native Intelligence app at all"), not per-record, and it needs its own table and route. No existing code uses Supabase Realtime channel presence for any record kind in an authorised way, and 675 adds no realtime publication for a spreadsheet. Building per-record presence would mean a channel carrying the spreadsheet id and a name in its payload, with no authorised precedent — the lead ruled it out tonight. So no "who else is here" is shown. |

What the engine's change sets carry, checked against the real runtime with a scratch
script before any of this was written (and pinned in `sync.test.ts`): cell inputs,
formulas **with their results**, styles and number formats, and sheet add, rename and
delete all travel and replay. Disjoint cells merge; the same cell ends with the replayed
(my) value — **last writer wins**. A change set is applied at its **absolute** address: a
row the other person inserted above a cell I edited does **not** re-base my edit (it lands
on its original row number). A change set aimed at a sheet the other person deleted throws
"Invalid sheet index"; it is caught, that one action is dropped with a one-sentence note,
and the rest still replay.

Not proven in this phase (said plainly): the merge was proven against two real engine
Models in tests, **not** with two live browsers on the server; there are no live cursors
and no keystroke-live editing (the lead's decision: no Realtime channel and no new
policies tonight — they cannot be verified without the dev project).

## Decisions to review

Made without asking, while the owner was away. Each can be changed.

1. **G D opens Drive, not Docs.** Every "G then a letter" was taken by 25 pages, so the
   Spreadsheets page had no letter left. G D now opens the Drive group on its page last used
   (Docs the first time), the way G S opens SEO, and Spreadsheets is reached through it.
   The other choice is to give Spreadsheets a letter another page has now.
2. **The engine is upstream IronCalc, on the page's own thread.** Not Macro's patched copy
   (it is AGPL like the rest of Macro), and not in a worker (see "Where it stands").
   AGGREGATE and GETPIVOTDATA, which Macro added to its copy, are therefore missing.
3. **NOW, TODAY and RAND calculate**, as in Excel. Macro blanks them to `#N/A` so two readers
   never differ; here a workbook is recalculated by whoever opens it, so two people can see
   different values of these until one saves.
4. **Comments on a spreadsheet are their own table** (`spreadsheet_comment`), not rows of the
   app's `comment` table, because that table's kinds are pinned by a test and an enum value
   cannot be added and used in one migration. They are anchored to cells.
5. **A spreadsheet is for the workspace or private, nothing between.** Sharing a private one
   with one member, a team or a channel needs five shared functions restated, which this
   work was told not to do.
6. **Whoever can read a spreadsheet can edit it** (and archive it); only its maker changes
   who sees it, and its maker or a workspace owner or admin deletes it. Documents have finer
   rules (system documents, product documents); a spreadsheet has no such kinds.
7. **Saving is the whole workbook against a revision.** Two people editing at once: the
   second save is refused with 409. Phase 5 replaced the old "you lose your work" answer
   with a merge (decision 26): the editor loads the newer workbook, replays its own
   unsaved changes onto it and saves again, so nobody's work is lost. It is not
   keystroke-live and shows no live cursors; others' changes arrive within a few seconds.
8. **A fill with no text color gets dark or white text by the fill's brightness**, in both
   themes, so a pale header row stays readable in the dark theme. Excel would draw black.
9. **Text typed into a plain-text cell is stored with the engine's quote prefix**, so
   `=1+1` and `007` stay as typed. Copying such a cell to another app gives the text
   without the prefix.
10. **Sorting moves formulas as typed.** Macro shifts their relative references; here a
    formula that points at its own row keeps pointing at the row it was written for.
11. **Fonts are the eight every machine has.** A font from an imported file that is not
    among them is kept in the workbook and drawn with the reader's fallback.
12. **Pushes went out before the full test run finished**, several times: the session's
    stop hook requires unpushed commits to be pushed. The managing session was told each
    time to hold until the run's result, and merged only on its own evidence.
13. **Validation, checkboxes and the conditional-formatting editor live in `extras`**, the
    record's jsonb column, not in the engine (the engine evaluates conditional formatting
    but has no data-validation or checkbox model). A change to them is one undo step with
    the engine, and the ranges are keyed by `sheet_id` so they follow reorders, renames,
    inserts and deletes. The conditional-formatting editor goes past Macro, which the plan
    allows.
14. **A rejecting validation rule pre-checks only a typed, non-formula value.** A formula
    is allowed through (its result is not known until it calculates); a paste or fill is
    re-checked after the write and rolled back whole if a rejecting cell ends up forbidden.
    So a formula whose result is not in a list is not caught. The other choice is to check
    every cell's computed value on each recalculation and mark it, which is heavier.
15. **A date validation rule compares the cell's displayed value as a number** (best-effort),
    since the engine gives no raw numeric read; number and text-length rules are exact. The
    dialog only makes list rules, so this matters only for imported rules later.
16. **Goal Seek is a secant step then a bracketing bisection** over a throwaway copy, read
    through a scratch cell in General format. It finds whichever root it brackets first for
    a function with several, and gives up after a fixed number of tries. A tighter solver
    (Brent) or a user-set tolerance could replace it.
17. **A dropdown's source range is read live from the displayed values**, deduped, in order,
    capped at 5,000 rows. A very long source is cut; blanks are skipped.
18. **Tables, charts and images live in `extras`**, keyed by `sheet_id`, drawn as overlays and
    floating objects, never written into the engine's cells. A change to any of them is one undo
    step with the engine, and `shiftExtras` moves them when rows, columns or sheets change. This
    matches the first part's choice for validation and checkboxes (decision 13).
19. **An image is stored as a data URL in `extras`, deduped by content hash** (the lead's decision:
    no new storage bucket). Caps: 1 MB an image, 4 MB of images a workbook, refused with a sentence.
    The file's kind is read from its magic bytes, not its name, so an SVG (which can carry script)
    and anything that is not PNG/JPEG/GIF/WebP are refused. The image blobs are kept out of the 1 MB
    extras size guard, which counts only the validation/table/chart data.
20. **A structured table reference is rewritten to plain A1 when it is typed, and the cell stores the
    A1 form.** `Sales[Amount]` becomes `B2:B10` before the engine (which knows nothing of tables)
    sees it. The cell does not turn back into a structured reference, and it follows a later table
    resize only as far as an A1 reference does (it does not re-expand when the table grows). A
    missing table or column becomes `#REF!`. The alternative — teaching the engine about tables — is
    not possible without patching it (we use upstream IronCalc).
21. **A table's total row uses SUBTOTAL so filtered/hidden rows drop out**, except "count unique",
    which is `COUNTA(UNIQUE(range))` and counts across hidden rows too (the engine has no
    hidden-aware unique count). The other aggregates are exact.
22. **Charts are our own SVG with a fixed seven types and a fixed palette.** No chart library was
    added (the app has none and the plan promised none); the more exotic kinds Macro lists wait
    until the common ones are right. A chart reads its range's calculated values on every data
    change, so it always reflects the latest numbers.
23. **"Bold first/last column" is drawn as a faint tint, not real bold text**, because the table
    look is an overlay that does not re-draw cell text. The toggle is stored and offered; making it
    real bold would mean writing cell styles (as Convert to range does) or re-drawing the text.
24. **No presence and no live channel tonight (the lead's call for phase 5).** Changes travel
    through the save path and a ~4-second poll, not a Realtime channel, and no "who else is here"
    is shown. The app's only presence is global app-presence (`user_presence`), not per-record;
    there is no authorised precedent for Realtime channel presence on a record kind, and 675 adds
    no publication. A per-record channel (carrying the spreadsheet id and a name) and the policies
    it needs wait for the owner's word and the dev project to verify them. Not keystroke-live; no
    live cursors.
25. **A spreadsheet comment's @-mentions are stored but do not notify or share.** The `mentions`
    column holds the validated member ids, but the app's comment-mention machinery is written for
    the `comment` table's kinds (`CommentableType` has no `spreadsheet`) and its mention-sharing
    grants per-person access, which a spreadsheet does not have (decision 5). Wiring it would need
    a schema/type change and per-person sharing, so a mention is recorded but silent for now.
26. **A save conflict merges instead of losing work (replaces decision 7).** The engine keeps a
    change set per action; the editor flushes one after each action (`pendingDiffs()`), and on a
    409 loads the newer workbook, replays those change sets onto it (`rebasePending`), and
    `adopt`s the result in place. Last writer wins on a shared cell; a cell edit lands at its
    absolute address even if the other person inserted rows above it (the engine's change sets are
    not rebased around structural edits); `WorkbookExtras` merge per top-level kind. `adopt` clears
    the undo history, because the engine model is replaced and the old step counts no longer match
    it — the one place soundness could not be kept. Bounded retries, then the existing "Not saved".
27. **Comment anchors follow row/column inserts and deletes, and move back on undo.** The
    controller emits a structural change (and its inverse on undo/redo) that the editor applies to
    the threads of that sheet, saving the moved anchors. A thread whose cells were wholly deleted
    survives, clamped to the cut and shown as "its cells were deleted". A sheet delete marks its
    threads the same way, but has no simple inverse, so undo of a sheet delete does not restore
    their anchors (the thread lives on, flagged).

## Dependencies

| Package | License | For |
| --- | --- | --- |
| `@ironcalc/wasm` 0.9.1 | MIT or Apache-2.0 | The engine. Its notices file lists no copyleft dependency. |

The .xlsx reader and writer are this repository's own code over `jszip` (MIT), which the app already had; nothing was added for them.
