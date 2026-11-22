/**
 * What the editor shows while a formula is typed: the functions whose names
 * start with what was typed, and, for the ones people use most, their
 * arguments and one line on what they do (written for this app).
 */
import { ENGINE_MISSING, FUNCTIONS_BY_CATEGORY, FUNCTION_CATEGORY_LABELS, type FunctionCategory } from './function-names'

export interface FunctionInfo {
  name: string
  category: FunctionCategory
  categoryLabel: string
  /** `SUM(number1, [number2], …)`. Absent for the long tail. */
  signature?: string
  summary?: string
}

const HELP: Record<string, [signature: string, summary: string]> = {
  SUM: ['SUM(number1, [number2], …)', 'Adds numbers and ranges.'],
  AVERAGE: ['AVERAGE(number1, [number2], …)', 'The mean of numbers and ranges.'],
  COUNT: ['COUNT(value1, [value2], …)', 'How many cells hold numbers.'],
  COUNTA: ['COUNTA(value1, [value2], …)', 'How many cells are not empty.'],
  COUNTBLANK: ['COUNTBLANK(range)', 'How many cells are empty.'],
  MIN: ['MIN(number1, [number2], …)', 'The smallest number.'],
  MAX: ['MAX(number1, [number2], …)', 'The largest number.'],
  MEDIAN: ['MEDIAN(number1, [number2], …)', 'The middle number.'],
  PRODUCT: ['PRODUCT(number1, [number2], …)', 'Multiplies numbers and ranges.'],
  ROUND: ['ROUND(number, digits)', 'Rounds to a number of decimal places.'],
  ROUNDUP: ['ROUNDUP(number, digits)', 'Rounds away from zero.'],
  ROUNDDOWN: ['ROUNDDOWN(number, digits)', 'Rounds toward zero.'],
  INT: ['INT(number)', 'Rounds down to a whole number.'],
  ABS: ['ABS(number)', 'A number without its sign.'],
  MOD: ['MOD(number, divisor)', 'The remainder after dividing.'],
  POWER: ['POWER(number, power)', 'A number raised to a power.'],
  SQRT: ['SQRT(number)', 'The square root.'],
  SUMIF: ['SUMIF(range, criteria, [sum_range])', 'Adds the cells that meet a condition.'],
  SUMIFS: ['SUMIFS(sum_range, range1, criteria1, …)', 'Adds the cells that meet every condition.'],
  SUMPRODUCT: ['SUMPRODUCT(array1, [array2], …)', 'Multiplies ranges cell by cell and adds the results.'],
  COUNTIF: ['COUNTIF(range, criteria)', 'How many cells meet a condition.'],
  COUNTIFS: ['COUNTIFS(range1, criteria1, …)', 'How many rows meet every condition.'],
  AVERAGEIF: ['AVERAGEIF(range, criteria, [average_range])', 'The mean of the cells that meet a condition.'],
  AVERAGEIFS: ['AVERAGEIFS(average_range, range1, criteria1, …)', 'The mean of the cells that meet every condition.'],
  MAXIFS: ['MAXIFS(max_range, range1, criteria1, …)', 'The largest of the cells that meet every condition.'],
  MINIFS: ['MINIFS(min_range, range1, criteria1, …)', 'The smallest of the cells that meet every condition.'],
  SUBTOTAL: ['SUBTOTAL(function_number, range1, …)', 'A total that leaves out hidden rows and other subtotals.'],
  IF: ['IF(condition, value_if_true, [value_if_false])', 'One value when a condition holds, another when it does not.'],
  IFS: ['IFS(condition1, value1, [condition2, value2], …)', 'The value for the first condition that holds.'],
  IFERROR: ['IFERROR(value, value_if_error)', 'A fallback when a formula gives an error.'],
  IFNA: ['IFNA(value, value_if_na)', 'A fallback when a formula gives #N/A.'],
  AND: ['AND(condition1, [condition2], …)', 'True when every condition holds.'],
  OR: ['OR(condition1, [condition2], …)', 'True when any condition holds.'],
  NOT: ['NOT(condition)', 'Turns true into false and false into true.'],
  SWITCH: ['SWITCH(value, case1, result1, …, [default])', 'The result for the case a value matches.'],
  VLOOKUP: ['VLOOKUP(value, table, column_number, [approximate])', 'Finds a value in a table’s first column and returns the cell beside it.'],
  HLOOKUP: ['HLOOKUP(value, table, row_number, [approximate])', 'Finds a value in a table’s first row and returns the cell under it.'],
  XLOOKUP: ['XLOOKUP(value, lookup_range, return_range, [if_not_found], [match_mode], [search_mode])', 'Finds a value in one range and returns the matching cell of another.'],
  INDEX: ['INDEX(range, row_number, [column_number])', 'The cell at a position in a range.'],
  MATCH: ['MATCH(value, range, [match_type])', 'The position of a value in a range.'],
  XMATCH: ['XMATCH(value, range, [match_mode], [search_mode])', 'The position of a value in a range.'],
  CHOOSE: ['CHOOSE(index, value1, [value2], …)', 'One of several values, by its number.'],
  OFFSET: ['OFFSET(reference, rows, columns, [height], [width])', 'A range a number of rows and columns away.'],
  INDIRECT: ['INDIRECT(reference_text)', 'The cell a piece of text names.'],
  FILTER: ['FILTER(range, include, [if_empty])', 'The rows of a range that meet a condition.'],
  SORT: ['SORT(range, [sort_index], [sort_order], [by_column])', 'A range, sorted.'],
  SORTBY: ['SORTBY(range, by_range1, [order1], …)', 'A range, sorted by another range.'],
  UNIQUE: ['UNIQUE(range, [by_column], [exactly_once])', 'A range without its repeats.'],
  SEQUENCE: ['SEQUENCE(rows, [columns], [start], [step])', 'A run of numbers.'],
  TRANSPOSE: ['TRANSPOSE(range)', 'Rows become columns and columns rows.'],
  ROW: ['ROW([reference])', 'A cell’s row number.'],
  COLUMN: ['COLUMN([reference])', 'A cell’s column number.'],
  ROWS: ['ROWS(range)', 'How many rows a range has.'],
  COLUMNS: ['COLUMNS(range)', 'How many columns a range has.'],
  CONCAT: ['CONCAT(text1, [text2], …)', 'Joins pieces of text.'],
  CONCATENATE: ['CONCATENATE(text1, [text2], …)', 'Joins pieces of text.'],
  TEXTJOIN: ['TEXTJOIN(delimiter, ignore_empty, text1, …)', 'Joins pieces of text with something between them.'],
  TEXT: ['TEXT(value, format)', 'A number as text in a format, like "0.00" or "mmm d".'],
  VALUE: ['VALUE(text)', 'Text that looks like a number, as a number.'],
  LEFT: ['LEFT(text, [characters])', 'The first characters of a text.'],
  RIGHT: ['RIGHT(text, [characters])', 'The last characters of a text.'],
  MID: ['MID(text, start, characters)', 'Characters from the middle of a text.'],
  LEN: ['LEN(text)', 'How many characters a text has.'],
  TRIM: ['TRIM(text)', 'Removes spaces at the ends and extra ones between words.'],
  UPPER: ['UPPER(text)', 'Text in capitals.'],
  LOWER: ['LOWER(text)', 'Text in small letters.'],
  PROPER: ['PROPER(text)', 'Each word with a capital first letter.'],
  FIND: ['FIND(find_text, within_text, [start])', 'Where one text sits inside another (case matters).'],
  SEARCH: ['SEARCH(find_text, within_text, [start])', 'Where one text sits inside another.'],
  SUBSTITUTE: ['SUBSTITUTE(text, old_text, new_text, [instance])', 'Swaps one piece of text for another.'],
  REPLACE: ['REPLACE(text, start, characters, new_text)', 'Swaps characters at a position for new text.'],
  TEXTSPLIT: ['TEXTSPLIT(text, column_delimiter, [row_delimiter])', 'Splits text into cells.'],
  TEXTBEFORE: ['TEXTBEFORE(text, delimiter, [instance])', 'The text before a delimiter.'],
  TEXTAFTER: ['TEXTAFTER(text, delimiter, [instance])', 'The text after a delimiter.'],
  TODAY: ['TODAY()', 'Today’s date.'],
  NOW: ['NOW()', 'The date and time now.'],
  DATE: ['DATE(year, month, day)', 'A date from its parts.'],
  YEAR: ['YEAR(date)', 'A date’s year.'],
  MONTH: ['MONTH(date)', 'A date’s month, 1 to 12.'],
  DAY: ['DAY(date)', 'A date’s day of the month.'],
  WEEKDAY: ['WEEKDAY(date, [type])', 'A date’s day of the week as a number.'],
  EDATE: ['EDATE(start_date, months)', 'The date a number of months later.'],
  EOMONTH: ['EOMONTH(start_date, months)', 'The last day of the month, a number of months later.'],
  DATEDIF: ['DATEDIF(start_date, end_date, unit)', 'The time between two dates in "Y", "M" or "D".'],
  DAYS: ['DAYS(end_date, start_date)', 'The days between two dates.'],
  NETWORKDAYS: ['NETWORKDAYS(start_date, end_date, [holidays])', 'The working days between two dates.'],
  WORKDAY: ['WORKDAY(start_date, days, [holidays])', 'The date a number of working days later.'],
  PMT: ['PMT(rate, periods, present_value, [future_value], [type])', 'The payment on a loan.'],
  FV: ['FV(rate, periods, payment, [present_value], [type])', 'What an investment grows to.'],
  PV: ['PV(rate, periods, payment, [future_value], [type])', 'What future payments are worth today.'],
  NPV: ['NPV(rate, value1, [value2], …)', 'The net present value of cash flows.'],
  IRR: ['IRR(values, [guess])', 'The internal rate of return of cash flows.'],
  XIRR: ['XIRR(values, dates, [guess])', 'The internal rate of return of dated cash flows.'],
  RATE: ['RATE(periods, payment, present_value, [future_value], [type], [guess])', 'The interest rate per period.'],
  ISBLANK: ['ISBLANK(value)', 'True when a cell is empty.'],
  ISNUMBER: ['ISNUMBER(value)', 'True when a value is a number.'],
  ISTEXT: ['ISTEXT(value)', 'True when a value is text.'],
  ISERROR: ['ISERROR(value)', 'True when a value is an error.'],
  LET: ['LET(name1, value1, …, calculation)', 'Names values to use in a calculation.'],
  LAMBDA: ['LAMBDA([parameter1, …], calculation)', 'A function of your own.'],
  STDEV: ['STDEV(number1, [number2], …)', 'The standard deviation of a sample.'],
  VAR: ['VAR(number1, [number2], …)', 'The variance of a sample.'],
  LARGE: ['LARGE(range, k)', 'The k-th largest number.'],
  SMALL: ['SMALL(range, k)', 'The k-th smallest number.'],
  RANK: ['RANK(number, range, [order])', 'Where a number stands in a list.'],
  PI: ['PI()', 'The number π.'],
  RAND: ['RAND()', 'A random number from 0 to 1.'],
  RANDBETWEEN: ['RANDBETWEEN(low, high)', 'A random whole number between two numbers.'],
}

export const FUNCTIONS: readonly FunctionInfo[] = (Object.keys(FUNCTIONS_BY_CATEGORY) as FunctionCategory[])
  .flatMap((category) =>
    FUNCTIONS_BY_CATEGORY[category]
      .filter((name) => !ENGINE_MISSING.includes(name))
      .map((name): FunctionInfo => {
        const help = HELP[name]
        return {
          name,
          category,
          categoryLabel: FUNCTION_CATEGORY_LABELS[category],
          ...(help ? { signature: help[0], summary: help[1] } : {}),
        }
      }),
  )
  .sort((a, b) => (a.name < b.name ? -1 : 1))

const BY_NAME = new Map(FUNCTIONS.map((f) => [f.name, f]))

export function functionInfo(name: string): FunctionInfo | null {
  return BY_NAME.get(name.toUpperCase()) ?? null
}

/**
 * Functions whose names start with what was typed, the ones with help
 * first (they are the ones people reach for), then by name.
 */
export function completeFunction(prefix: string, limit = 8): FunctionInfo[] {
  const p = prefix.toUpperCase()
  if (!p) return []
  const hits = FUNCTIONS.filter((f) => f.name.startsWith(p))
  hits.sort((a, b) => Number(Boolean(b.signature)) - Number(Boolean(a.signature)) || a.name.length - b.name.length || (a.name < b.name ? -1 : 1))
  return hits.slice(0, limit)
}
