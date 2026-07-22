suppressWarnings({
  if (!requireNamespace("jsonlite", quietly = TRUE)) {
    cat('{"status":"error","message":"R dependency missing: jsonlite. Please install it with install.packages(\\"jsonlite\\").","diagnostic":{"schemaVersion":"1.0","type":"missing_package","category":"missing_package","kind":"missing_package","severity":"error","message":"jsonlite is required by the R renderer.","suggestion":"Install the required R package in the renderer environment or remove the dependency.","conditionClass":[],"details":{"source":"r_renderer","package":"jsonlite"}}}')
    quit(status = 0)
  }
})

# Keep collation deterministic without overriding the Docker UTF-8 character type locale.
invisible(try(Sys.setlocale(category = "LC_COLLATE", locale = "C"), silent = TRUE))

emit_json <- function(value, digits = NA) {
  json <- jsonlite::toJSON(
    value,
    auto_unbox = TRUE,
    null = "null",
    digits = digits
  )
  writeLines(enc2utf8(as.character(json)), con = stdout(), sep = "", useBytes = TRUE)
}

args <- commandArgs(trailingOnly = TRUE)
payload_file <- NULL
for (i in seq_along(args)) {
  if (args[[i]] == "--payload-file" && i < length(args)) {
    payload_file <- args[[i + 1]]
  }
}

if (is.null(payload_file) || !file.exists(payload_file)) {
  emit_json(list(
    status = "error",
    message = "payload file is required",
    diagnostic = list(
      schemaVersion = "1.0",
      type = "missing_file",
      category = "missing_file",
      kind = "missing_file",
      severity = "error",
      message = "payload file is required",
      suggestion = "Provide the renderer payload file before starting the R job.",
      conditionClass = list(),
      details = list(source = "r_renderer", path = payload_file)
    ),
    warningDiagnostics = list()
  ))
  quit(status = 0)
}

safe_runtime_string <- function(value) {
  if (is.null(value) || length(value) == 0 || is.na(value[[1]])) return(NULL)
  text <- as.character(value[[1]])
  if (!nzchar(text)) return(NULL)
  text
}

safe_runtime_path <- function(value) {
  text <- safe_runtime_string(value)
  if (is.null(text)) return(NULL)
  tryCatch(
    normalizePath(text, winslash = "/", mustWork = FALSE),
    error = function(e) text
  )
}

safe_runtime_package <- function(package_name) {
  installed <- requireNamespace(package_name, quietly = TRUE)
  version <- if (installed) {
    tryCatch(as.character(utils::packageVersion(package_name)), error = function(e) NULL)
  } else {
    NULL
  }
  list(installed = installed, version = version)
}

runtime_font_inventory <- function() {
  candidates <- c(
    "Times New Roman", "Arial", "DejaVu Sans", "SimHei",
    "Microsoft YaHei", "Noto Sans CJK SC", "Noto Sans CJK", "FreeSans"
  )
  families <- character()
  font_table <- NULL
  provider <- "none"
  if (requireNamespace("systemfonts", quietly = TRUE)) {
    provider <- "systemfonts"
    font_table <- tryCatch(systemfonts::system_fonts(), error = function(e) NULL)
    families <- if (is.data.frame(font_table) && "family" %in% names(font_table)) {
      unique(as.character(font_table$family))
    } else {
      character()
    }
  }
  if (length(families) == 0) {
    provider <- "grDevices::pdfFonts"
    families <- tryCatch(names(grDevices::pdfFonts()), error = function(e) character())
  }
  normalized <- tolower(trimws(families))
  declared_aliases <- list("Times" = c("Times New Roman", "Liberation Serif", "FreeSerif"))
  exact_matches <- setNames(vapply(candidates, function(candidate) {
    tolower(trimws(candidate)) %in% normalized
  }, logical(1)), candidates)
  resolved_families <- setNames(lapply(candidates, function(candidate) {
    if (!is.data.frame(font_table) || !all(c("path", "family") %in% names(font_table))) return(NULL)
    matched_path <- tryCatch({
      matched <- systemfonts::match_fonts(candidate)
      if (is.data.frame(matched) && nrow(matched) > 0) as.character(matched$path[[1]]) else NULL
    }, error = function(e) NULL)
    if (is.null(matched_path) || !nzchar(matched_path)) return(NULL)
    normalized_paths <- vapply(font_table$path, safe_runtime_path, character(1))
    matched_rows <- which(normalized_paths == safe_runtime_path(matched_path))
    if (length(matched_rows) == 0) return(NULL)
    safe_runtime_string(font_table$family[[matched_rows[[1]]]])
  }), candidates)
  matches <- setNames(vapply(candidates, function(candidate) {
    if (isTRUE(exact_matches[[candidate]])) return(TRUE)
    resolved <- resolved_families[[candidate]]
    allowed <- declared_aliases[[candidate]]
    !is.null(resolved) && length(allowed) > 0 && tolower(resolved) %in% tolower(allowed)
  }, logical(1)), candidates)
  list(
    provider = provider,
    availableFamilyCount = length(unique(families)),
    candidates = as.list(matches),
    exactCandidates = as.list(exact_matches),
    resolvedFamilies = resolved_families,
    declaredAliases = declared_aliases
  )
}

runtime_environment_contract <- function() {
  list(
    home = safe_runtime_path(Sys.getenv("HOME", unset = "")),
    userProfile = safe_runtime_path(Sys.getenv("USERPROFILE", unset = "")),
    tmpdir = safe_runtime_path(Sys.getenv("TMPDIR", unset = "")),
    tmp = safe_runtime_path(Sys.getenv("TMP", unset = "")),
    temp = safe_runtime_path(Sys.getenv("TEMP", unset = "")),
    tz = safe_runtime_string(Sys.getenv("TZ", unset = "")),
    rUser = safe_runtime_path(Sys.getenv("R_USER", unset = "")),
    xdgCacheHome = safe_runtime_path(Sys.getenv("XDG_CACHE_HOME", unset = ""))
  )
}

collect_runtime_inventory <- function() {
  required_packages <- c("jsonlite")
  optional_packages <- c("ggplot2", "svglite", "readxl", "systemfonts", "textshaping")
  package_names <- c(required_packages, optional_packages)
  packages <- lapply(package_names, safe_runtime_package)
  names(packages) <- package_names
  missing_required <- required_packages[!vapply(packages[required_packages], function(item) isTRUE(item$installed), logical(1))]
  rscript_candidates <- unique(c(
    Sys.getenv("SCIFIGURE_RSCRIPT_BIN", unset = ""),
    Sys.getenv("RSCRIPT_BIN", unset = ""),
    Sys.which("Rscript"),
    file.path(R.home("bin"), if (.Platform$OS.type == "windows") "Rscript.exe" else "Rscript")
  ))
  rscript_candidates <- rscript_candidates[nzchar(rscript_candidates)]
  locale_categories <- c("LC_COLLATE", "LC_CTYPE", "LC_MONETARY", "LC_NUMERIC", "LC_TIME")
  locale_info <- setNames(lapply(locale_categories, function(category) {
    tryCatch(safe_runtime_string(Sys.getlocale(category = category)), error = function(e) NULL)
  }), locale_categories)
  list(
    schemaVersion = "1.0",
    executable = list(
      rscript = if (length(rscript_candidates) > 0) safe_runtime_path(rscript_candidates[[1]]) else NULL,
      candidates = as.list(vapply(rscript_candidates, safe_runtime_path, character(1)))
    ),
    r = list(
      version = as.character(R.version$version.string),
      platform = as.character(R.version$platform),
      arch = as.character(R.version$arch),
      os = as.character(R.version$os),
      home = safe_runtime_path(R.home())
    ),
    packages = packages,
    libraryPaths = as.list(vapply(.libPaths(), safe_runtime_path, character(1))),
    locale = list(
      all = safe_runtime_string(Sys.getlocale()),
      categories = locale_info,
      lang = safe_runtime_string(Sys.getenv("LANG", unset = "")),
      lcAll = safe_runtime_string(Sys.getenv("LC_ALL", unset = "")),
      charset = tryCatch(as.list(localeToCharset()), error = function(e) list()),
      nativeEncoding = safe_runtime_string(l10n_info()[["codepage"]]),
      contract = list(collate = "C", ctypeEncoding = "UTF-8")
    ),
    timezone = safe_runtime_string(Sys.timezone()),
    environment = runtime_environment_contract(),
    workingDirectory = safe_runtime_path(getwd()),
    temporaryDirectory = safe_runtime_path(tempdir()),
    graphics = list(
      activeDevice = tryCatch(as.character(names(grDevices::dev.cur())), error = function(e) NULL),
      preferredSvgDevice = if (isTRUE(packages$svglite$installed)) "svglite" else "grDevices::svg"
    ),
    fonts = runtime_font_inventory(),
    checks = list(
      ok = length(missing_required) == 0,
      missingRequiredPackages = as.list(missing_required)
    )
  )
}

runtime_condition_message <- function(condition, fallback = "") {
  if (is.null(condition)) return(fallback)
  message <- tryCatch(conditionMessage(condition), error = function(e) "")
  if (length(message) == 0 || is.na(message[[1]])) fallback else as.character(message[[1]])
}

runtime_condition_classes <- function(condition) {
  if (is.null(condition)) return(character())
  classes <- tryCatch(class(condition), error = function(e) character())
  if (is.null(classes)) character() else as.character(classes)
}

runtime_condition_call <- function(condition) {
  call <- tryCatch(conditionCall(condition), error = function(e) NULL)
  if (is.null(call)) return(NULL)
  text <- tryCatch(paste(deparse(call), collapse = " "), error = function(e) "")
  if (!nzchar(text)) NULL else text
}

runtime_extract_token <- function(message, pattern) {
  match <- tryCatch(regexec(pattern, message, ignore.case = TRUE, perl = TRUE), error = function(e) NULL)
  if (is.null(match)) return(NULL)
  groups <- regmatches(message, match)[[1]]
  if (length(groups) < 2 || !nzchar(groups[[2]])) NULL else groups[[2]]
}

runtime_clean_token <- function(value) {
  if (is.null(value) || length(value) == 0 || is.na(value[[1]])) return(NULL)
  token <- trimws(as.character(value[[1]]))
  token <- sub("^[^[:alnum:]_.-]+", "", token, perl = TRUE)
  token <- sub("[^[:alnum:]_.-].*$", "", token, perl = TRUE)
  if (!nzchar(token)) NULL else token
}

runtime_clean_path <- function(value) {
  if (is.null(value) || length(value) == 0 || is.na(value[[1]])) return(NULL)
  path <- trimws(as.character(value[[1]]))
  path <- gsub("^[[:space:]'\"`]+|[[:space:]'\"`]+$", "", path, perl = TRUE)
  if (!nzchar(path)) NULL else path
}

runtime_extract_missing_symbol <- function(message) {
  token <- runtime_extract_token(message, "object[[:space:]]+(.+?)[[:space:]]+not found")
  if (is.null(token)) token <- runtime_extract_token(message, "column[[:space:]]+(.+?)[[:space:]]+not found")
  if (is.null(token)) token <- runtime_extract_token(message, "function[[:space:]]+(.+?)[[:space:]]+not found")
  runtime_clean_token(token)
}

runtime_extract_missing_package <- function(message) {
  if (grepl("there is no package called", message, ignore.case = TRUE, perl = TRUE)) {
    candidate <- sub("^.*there is no package called", "", message, ignore.case = TRUE, perl = TRUE)
    return(runtime_clean_token(candidate))
  }
  token <- runtime_extract_token(message, "package[[:space:]]+(.+?)[[:space:]]+is not available")
  runtime_clean_token(token)
}

runtime_extract_missing_path <- function(message) {
  token <- runtime_extract_token(message, "cannot open file[[:space:]]+['\"]([^'\"]+)['\"]")
  if (is.null(token)) token <- runtime_extract_token(message, "cannot open file[[:space:]]+(.+)")
  if (is.null(token)) token <- runtime_extract_token(message, "file[[:space:]]+(.+?)[[:space:]]+(does not exist|not found)")
  token <- runtime_clean_path(token)
  if (!is.null(token)) {
    token <- sub("[[:space:]]*:[[:space:]]*(no such file.*|permission denied.*|access is denied.*)$", "", token, ignore.case = TRUE, perl = TRUE)
  }
  token
}

runtime_data_summary <- function(payload) {
  data_payload <- tryCatch(payload$dataPayload, error = function(e) NULL)
  custom_data <- tryCatch(data_payload$custom_data, error = function(e) NULL)
  if (is.null(custom_data)) custom_data <- data_payload

  row_count <- 0L
  columns <- character()
  if (is.data.frame(custom_data)) {
    row_count <- nrow(custom_data)
    columns <- names(custom_data)
  } else if (is.list(custom_data)) {
    row_count <- length(custom_data)
    if (length(custom_data) > 0 && is.list(custom_data[[1]])) {
      columns <- names(custom_data[[1]])
    }
  }
  list(rowCount = row_count, columns = as.list(as.character(columns)))
}

runtime_condition_category <- function(condition, message = runtime_condition_message(condition)) {
  lower_message <- tolower(message)
  classes <- tolower(runtime_condition_classes(condition))

  if (
    grepl("parse error|syntax error|unexpected", lower_message, perl = TRUE) ||
    any(classes %in% c("parseerror", "parse_error"))
  ) {
    return("syntax_error")
  }
  if (grepl("permission denied|access is denied|operation not permitted|not permitted", lower_message, perl = TRUE)) {
    return("permission_denied")
  }
  if (
    any(classes %in% c("packagenotfounderror", "packageerror")) ||
    grepl("there is no package called|package .* is not available", lower_message, perl = TRUE)
  ) {
    return("missing_package")
  }
  if (
    grepl(
      "object .* not found|undefined columns selected|column .* not found|can't subset columns|cannot subset columns|\\$ operator is invalid",
      lower_message,
      perl = TRUE
    )
  ) {
    return("missing_data")
  }
  if (
    grepl("no such file or directory|cannot open (file|the connection)|does not exist|file .* not found", lower_message, perl = TRUE)
  ) {
    return("missing_file")
  }
  "runtime_error"
}

runtime_is_font_warning <- function(condition) {
  message <- tolower(runtime_condition_message(condition))
  grepl(
    "font.*(not found|missing|unavailable)|(not found|missing|unavailable).*font",
    message,
    perl = TRUE
  )
}

runtime_diagnostic_suggestion <- function(category) {
  suggestions <- c(
    syntax_error = "Check R syntax and the reported line/column before rendering.",
    missing_package = "Install the required R package in the renderer environment or remove the dependency.",
    missing_data = "Check the uploaded data columns and objects referenced by the R script.",
    missing_file = "Provide the file through the renderer payload or use a declared local input.",
    permission_denied = "Check renderer permissions and the requested path before rendering.",
    missing_font = "Use an installed font or provide a configured fallback font.",
    runtime_error = "Inspect the R condition and call context, then correct the script or input.",
    `default` = "Inspect the R condition and call context, then correct the script or input."
  )
  suggestion <- suggestions[[category]]
  if (is.null(suggestion)) suggestions[["default"]] else suggestion
}

runtime_diagnostic <- function(condition = NULL, payload = NULL, category = NULL, severity = "error", message = NULL) {
  condition_message <- if (is.null(message)) runtime_condition_message(condition) else as.character(message)
  if (is.null(category)) {
    category <- runtime_condition_category(condition, condition_message)
    if (identical(category, "missing_file") && exists("warnings_collected", inherits = TRUE)) {
      prior_warnings <- get("warnings_collected", inherits = TRUE)
      if (any(grepl("permission denied|access is denied|operation not permitted|not permitted", prior_warnings, ignore.case = TRUE, perl = TRUE))) {
        category <- "permission_denied"
      }
    }
  }

  details <- list(source = "r_renderer")
  if (identical(category, "syntax_error")) {
    location <- regexec(":([0-9]+):([0-9]+):", condition_message, perl = TRUE)
    groups <- regmatches(condition_message, location)[[1]]
    if (length(groups) >= 3) {
      details$line <- suppressWarnings(as.integer(groups[[2]]))
      details$column <- suppressWarnings(as.integer(groups[[3]]))
    }
  }
  if (identical(category, "missing_package")) {
    package_name <- runtime_extract_missing_package(condition_message)
    function_name <- runtime_extract_token(condition_message, "could not find function[[:space:]]+(.+)")
    if (!is.null(package_name)) details$package <- package_name
    if (!is.null(function_name)) details[["function"]] <- runtime_clean_token(function_name)
  }
  if (identical(category, "missing_data")) {
    symbol <- runtime_extract_missing_symbol(condition_message)
    if (!is.null(symbol)) details$symbol <- symbol
    details$data <- runtime_data_summary(payload)
  }
  if (identical(category, "missing_file") || identical(category, "permission_denied")) {
    path_message <- condition_message
    if (exists("warnings_collected", inherits = TRUE)) {
      prior_warnings <- get("warnings_collected", inherits = TRUE)
      if (length(prior_warnings) > 0) path_message <- paste(c(prior_warnings, condition_message), collapse = "\n")
    }
    path <- runtime_extract_missing_path(path_message)
    if (!is.null(path)) details$path <- path
  }
  if (identical(category, "missing_font")) {
    font_family <- runtime_extract_token(condition_message, "font[[:space:]]+family[[:space:]]+(.+?)[[:space:]]+not found")
    if (!is.null(font_family)) details$fontFamily <- runtime_clean_token(font_family)
  }

  classes <- runtime_condition_classes(condition)
  call <- runtime_condition_call(condition)
  diagnostic <- list(
    schemaVersion = "1.0",
    type = category,
    category = category,
    kind = category,
    severity = severity,
    message = condition_message,
    suggestion = runtime_diagnostic_suggestion(category),
    conditionClass = as.list(classes),
    details = details
  )
  if (!is.null(call)) diagnostic$call <- call
  diagnostic
}

payload <- jsonlite::fromJSON(payload_file, simplifyVector = TRUE)
raw_payload <- jsonlite::fromJSON(payload_file, simplifyVector = FALSE)
script <- payload$script
if (is.null(script) || !nzchar(script)) {
  emit_json(list(
    status = "error",
    message = "R script is required",
    diagnostic = runtime_diagnostic(
      condition = NULL,
      payload = payload,
      category = "runtime_error",
      message = "R script is required"
    ),
    warningDiagnostics = list(),
    runtimeInventory = collect_runtime_inventory()
  ))
  quit(status = 0)
}

runtime_inventory <- collect_runtime_inventory()

render_options <- payload$renderOptions
width <- 7
height <- 5
if (!is.null(render_options$width_in)) width <- as.numeric(render_options$width_in)
if (!is.null(render_options$height_in)) height <- as.numeric(render_options$height_in)

tmp_svg <- tempfile(fileext = ".svg")
warnings_collected <- character()
runtime_warning_diagnostics <- list()
renderer_patch_warnings <- list()

add_runtime_warning_diagnostic <- function(condition) {
  if (!runtime_is_font_warning(condition)) return(invisible(NULL))
  diagnostic <- runtime_diagnostic(
    condition = condition,
    payload = payload,
    category = "missing_font",
    severity = "warning"
  )
  key <- paste(diagnostic$type, diagnostic$message, sep = "\u001f")
  existing_keys <- vapply(runtime_warning_diagnostics, function(item) {
    paste(item$type, item$message, sep = "\u001f")
  }, character(1))
  if (!key %in% existing_keys) {
    runtime_warning_diagnostics[[length(runtime_warning_diagnostics) + 1]] <<- diagnostic
  }
  invisible(NULL)
}

add_warning_once <- function(message) {
  warnings_collected <<- unique(c(warnings_collected, message))
}

add_patch_warning_once <- function(type, gid, prop, message) {
  key <- paste(type, gid, prop, message, sep = "\u001f")
  existing_keys <- vapply(renderer_patch_warnings, function(item) {
    paste(item$type, item$gid, item$prop, item$message, sep = "\u001f")
  }, character(1))
  if (!key %in% existing_keys) {
    renderer_patch_warnings[[length(renderer_patch_warnings) + 1]] <<- list(
      type = type,
      gid = gid,
      prop = prop,
      message = message
    )
  }
}

as_edit_entries <- function(edit_log) {
  if (is.null(edit_log)) return(list())
  if (is.data.frame(edit_log)) {
    if (nrow(edit_log) == 0) return(list())
    return(lapply(seq_len(nrow(edit_log)), function(i) as.list(edit_log[i, , drop = FALSE])))
  }
  if (is.list(edit_log)) return(edit_log)
  list()
}

requested_edit_entries <- as_edit_entries(raw_payload$editLog)
edit_entries <- requested_edit_entries
r_edit_resolution <- list(accepted = edit_entries, rejected = list(), warnings = list())

latest_value <- function(gid, prop, fallback) {
  value <- fallback
  for (entry in edit_entries) {
    if (identical(as.character(entry$gid), gid) && identical(as.character(entry$prop), prop)) {
      value <- entry$value
      if (is.list(value) && length(value) == 1 && is.null(names(value))) {
        value <- value[[1]]
      }
    }
  }
  value
}

has_edit <- function(gid, prop) {
  for (entry in edit_entries) {
    if (identical(as.character(entry$gid), gid) && identical(as.character(entry$prop), prop)) {
      return(TRUE)
    }
  }
  FALSE
}

latest_numeric <- function(gid, prop, fallback) {
  value <- suppressWarnings(as.numeric(latest_value(gid, prop, fallback)))
  if (length(value) == 0 || is.na(value)) fallback else value
}

latest_string <- function(gid, prop, fallback) {
  value <- latest_value(gid, prop, fallback)
  if (is.null(value) || length(value) == 0) fallback else as.character(value)
}

latest_bool <- function(gid, prop, fallback) {
  value <- latest_value(gid, prop, fallback)
  if (is.null(value) || length(value) == 0) return(isTRUE(fallback))
  if (is.logical(value)) return(isTRUE(value[[1]]))
  text <- tolower(as.character(value[[1]]))
  if (text %in% c("true", "t", "1", "yes", "y")) return(TRUE)
  if (text %in% c("false", "f", "0", "no", "n")) return(FALSE)
  isTRUE(fallback)
}

latest_prefixed_value <- function(prefix, prop, fallback) {
  value <- fallback
  for (entry in edit_entries) {
    gid <- as.character(entry$gid)
    if (startsWith(gid, prefix) && identical(as.character(entry$prop), prop)) {
      value <- entry$value
      if (is.list(value) && length(value) == 1 && is.null(names(value))) {
        value <- value[[1]]
      }
    }
  }
  value
}

latest_prefixed_numeric <- function(prefix, prop, fallback) {
  value <- suppressWarnings(as.numeric(latest_prefixed_value(prefix, prop, fallback)))
  if (length(value) == 0 || is.na(value)) fallback else value
}

latest_prefixed_string <- function(prefix, prop, fallback) {
  value <- latest_prefixed_value(prefix, prop, fallback)
  if (is.null(value) || length(value) == 0) fallback else as.character(value)
}

latest_matching_value <- function(pattern, prop, fallback) {
  value <- fallback
  for (entry in edit_entries) {
    gid <- as.character(entry$gid)
    if (grepl(pattern, gid, perl = TRUE) && identical(as.character(entry$prop), prop)) {
      value <- entry$value
      if (is.list(value) && length(value) == 1 && is.null(names(value))) {
        value <- value[[1]]
      }
    }
  }
  value
}

latest_matching_numeric <- function(pattern, prop, fallback) {
  value <- suppressWarnings(as.numeric(latest_matching_value(pattern, prop, fallback)))
  if (length(value) == 0 || is.na(value)) fallback else value
}

latest_matching_string <- function(pattern, prop, fallback) {
  value <- latest_matching_value(pattern, prop, fallback)
  if (is.null(value) || length(value) == 0) fallback else as.character(value)
}

alpha_color <- function(color, alpha) {
  if (is.null(color) || length(color) == 0 || is.na(color[[1]])) return(color)
  alpha_num <- suppressWarnings(as.numeric(alpha))
  if (length(alpha_num) == 0 || is.na(alpha_num)) return(color)
  alpha_num <- max(0, min(1, alpha_num))
  tryCatch(grDevices::adjustcolor(as.character(color), alpha.f = alpha_num), error = function(e) color)
}

if (length(edit_entries) > 0) {
  width <- latest_numeric("global", "figure.width_in", width)
  height <- latest_numeric("global", "figure.height_in", height)
}

font_face <- function(weight, style) {
  is_bold <- weight %in% c("bold", "semibold", "700")
  is_italic <- style %in% c("italic", "oblique")
  if (is_bold && is_italic) return("bold.italic")
  if (is_bold) return("bold")
  if (is_italic) return("italic")
  "plain"
}

style_for_gid <- function(gid, defaults) {
  weight <- latest_string(gid, "fontweight", defaults$fontweight)
  style <- latest_string(gid, "fontstyle", defaults$fontstyle)
  list(
    fontsize = latest_numeric(gid, "fontsize", defaults$fontsize),
    fontfamily = latest_string(gid, "fontfamily", defaults$fontfamily),
    color = latest_string(gid, "color", defaults$color),
    fontweight = weight,
    fontstyle = style,
    face = font_face(weight, style)
  )
}

axis_style_for_gid <- function(gid, defaults) {
  tick_prefix <- if (grepl("^axis\\.x\\.", gid)) {
    sub("^axis\\.x\\.(\\d+)$", "xtick.\\1.", gid)
  } else if (grepl("^axis\\.y\\.", gid)) {
    sub("^axis\\.y\\.(\\d+)$", "ytick.\\1.", gid)
  } else {
    ""
  }
  axis_pattern <- if (grepl("^axis\\.x\\.", gid)) "^axis\\.x\\.\\d+$" else if (grepl("^axis\\.y\\.", gid)) "^axis\\.y\\.\\d+$" else paste0("^", gid, "$")
  tick_pattern <- if (grepl("^axis\\.x\\.", gid)) "^xtick\\.\\d+\\." else if (grepl("^axis\\.y\\.", gid)) "^ytick\\.\\d+\\." else paste0("^", tick_prefix)

  weight <- latest_matching_string(axis_pattern, "tick_fontweight", latest_string(gid, "tick_fontweight", latest_string(gid, "fontweight", defaults$fontweight)))
  style <- latest_matching_string(axis_pattern, "tick_fontstyle", latest_string(gid, "tick_fontstyle", latest_string(gid, "fontstyle", defaults$fontstyle)))
  weight <- latest_matching_string(tick_pattern, "fontweight", weight)
  style <- latest_matching_string(tick_pattern, "fontstyle", style)

  fontsize <- latest_matching_numeric(axis_pattern, "tick_labelsize", latest_numeric(gid, "tick_labelsize", latest_numeric(gid, "fontsize", defaults$fontsize)))
  fontfamily <- latest_matching_string(axis_pattern, "tick_labelfamily", latest_string(gid, "tick_labelfamily", latest_string(gid, "fontfamily", defaults$fontfamily)))
  color <- latest_matching_string(axis_pattern, "tick_labelcolor", latest_string(gid, "tick_labelcolor", latest_string(gid, "color", defaults$color)))
  rotation <- latest_matching_numeric(axis_pattern, "tick_rotation", latest_numeric(gid, "tick_rotation", defaults$rotation))
  fontsize <- latest_matching_numeric(tick_pattern, "fontsize", fontsize)
  fontfamily <- latest_matching_string(tick_pattern, "fontfamily", fontfamily)
  color <- latest_matching_string(tick_pattern, "color", color)
  rotation <- latest_matching_numeric(tick_pattern, "rotation", rotation)

  list(
    fontsize = fontsize,
    fontfamily = fontfamily,
    color = color,
    fontweight = weight,
    fontstyle = style,
    face = font_face(weight, style),
    rotation = rotation,
    direction = latest_matching_string(axis_pattern, "tick_direction", latest_string(gid, "tick_direction", defaults$direction)),
    length = latest_matching_numeric(axis_pattern, "tick_length", latest_numeric(gid, "tick_length", defaults$length)),
    width = latest_matching_numeric(axis_pattern, "tick_width", latest_numeric(gid, "tick_width", defaults$width)),
    tick_color = latest_matching_string(axis_pattern, "tick_color", latest_string(gid, "tick_color", defaults$tick_color)),
    pad = latest_matching_numeric(axis_pattern, "tick_pad", latest_numeric(gid, "tick_pad", defaults$pad))
  )
}

axis_label_style_for_gid <- function(axis_gid, label_gid, defaults) {
  axis_pattern <- if (grepl("^axis\\.x\\.", axis_gid)) "^axis\\.x\\.\\d+$" else if (grepl("^axis\\.y\\.", axis_gid)) "^axis\\.y\\.\\d+$" else paste0("^", axis_gid, "$")
  style <- style_for_gid(label_gid, defaults)
  style$fontsize <- latest_matching_numeric(axis_pattern, "label_fontsize", style$fontsize)
  style$color <- latest_matching_string(axis_pattern, "label_color", style$color)
  style$face <- font_face(style$fontweight, style$fontstyle)
  style
}

axis_label_text_for_gid <- function(axis_gid, label_gid, fallback) {
  axis_pattern <- if (grepl("^axis\\.x\\.", axis_gid)) "^axis\\.x\\.\\d+$" else if (grepl("^axis\\.y\\.", axis_gid)) "^axis\\.y\\.\\d+$" else paste0("^", axis_gid, "$")
  latest_matching_string(axis_pattern, "label", latest_string(label_gid, "text", fallback))
}

default_title <- list(fontsize = 14, fontfamily = "", color = "black", fontweight = "normal", fontstyle = "normal")
default_label <- list(fontsize = 11, fontfamily = "", color = "black", fontweight = "normal", fontstyle = "normal")
default_tick <- list(
  fontsize = 9,
  fontfamily = "",
  color = "black",
  fontweight = "normal",
  fontstyle = "normal",
  rotation = 0,
  direction = "out",
  length = 3.5,
  width = 0.8,
  tick_color = "#000000",
  pad = 3.5
)
default_legend <- list(
  fontsize = 10,
  fontfamily = "",
  color = "black",
  fontweight = "normal",
  fontstyle = "normal",
  visible = TRUE,
  loc = "right",
  facecolor = "white",
  edgecolor = "none",
  linewidth = 0.5,
  alpha = 1.0,
  ncol = 1,
  markerscale = 1.0,
  handletextpad = 0.8,
  labelspacing = 0.5,
  columnspacing = 2.0,
  borderpad = 0.4
)
default_colorbar <- list(
  left = 0.88,
  bottom = 0.50,
  width = 0.05,
  height = 0.35
)
default_strip <- list(fontsize = 10, fontfamily = "", color = "black", fontweight = "normal", fontstyle = "normal")

clamp_numeric <- function(value, min_value, max_value) {
  value <- suppressWarnings(as.numeric(value))
  if (length(value) == 0 || is.na(value)) return(min_value)
  max(min_value, min(max_value, value))
}

subplot_aspect_value <- function() {
  value <- latest_matching_value("^subplot\\.\\d+$", "aspect", "auto")
  text <- as.character(value %||% "auto")
  if (text %in% c("auto", "", "NA")) return("auto")
  if (text %in% c("equal", "1")) return(1)
  numeric_value <- suppressWarnings(as.numeric(text))
  if (length(numeric_value) == 0 || is.na(numeric_value) || numeric_value <= 0) return("auto")
  numeric_value
}

geom_class <- function(layer) {
  classes <- class(layer$geom)
  if (length(classes) == 0) return("Geom")
  classes[[1]]
}

layer_kind <- function(geom) {
  if (geom %in% c("GeomPoint", "GeomJitter", "GeomDotplot")) return("collection")
  if (geom %in% c("GeomText", "GeomLabel")) return("text")
  if (geom %in% c("GeomLine", "GeomPath", "GeomSmooth", "GeomSegment", "GeomCurve", "GeomHline", "GeomVline", "GeomAbline", "GeomDensity", "GeomFreqpoly")) return("line")
  if (geom %in% c("GeomBoxplot")) return("boxplot_container")
  if (geom %in% c("GeomViolin")) return("violinplot_container")
  if (geom %in% c("GeomCol", "GeomBar", "GeomTile", "GeomRaster", "GeomRect", "GeomRibbon", "GeomArea")) return("patch")
  if (geom %in% c("GeomErrorbar", "GeomErrorbarh", "GeomPointrange", "GeomLinerange", "GeomCrossbar")) return("errorbar_container")
  "unsupported"
}

layer_label <- function(geom, index) {
  label <- switch(
    geom,
    GeomPoint = "ggplot scatter layer",
    GeomJitter = "ggplot jitter layer",
    GeomLine = "ggplot line layer",
    GeomPath = "ggplot path layer",
    GeomCol = "ggplot column layer",
    GeomBar = "ggplot bar layer",
    GeomErrorbar = "ggplot errorbar layer",
    GeomText = "ggplot text layer",
    GeomLabel = "ggplot label layer",
    GeomBoxplot = "ggplot boxplot layer",
    GeomViolin = "ggplot violin layer",
    GeomSmooth = "ggplot smooth layer",
    paste("ggplot layer", index)
  )
  paste0(label, " ", index)
}

layer_params <- function(layer) {
  params <- layer$aes_params
  if (is.null(params)) params <- list()
  params
}

param_value <- function(params, names, fallback = NULL) {
  for (name in names) {
    if (!is.null(params[[name]])) return(params[[name]])
  }
  fallback
}

as_hex_or_fallback <- function(value, fallback) {
  if (is.null(value) || length(value) == 0) return(fallback)
  as.character(value[[1]])
}

layer_current_props <- function(layer, gid) {
  params <- layer_params(layer)
  props <- list(
    color = latest_string(gid, "color", as_hex_or_fallback(param_value(params, c("colour", "color")), "#1F77B4")),
    facecolor = latest_string(gid, "facecolor", as_hex_or_fallback(param_value(params, c("fill")), "#1F77B4")),
    edgecolor = latest_string(gid, "edgecolor", as_hex_or_fallback(param_value(params, c("colour", "color")), "#000000")),
    linewidth = latest_numeric(gid, "linewidth", as.numeric(param_value(params, c("linewidth", "size"), 1))),
    size = latest_numeric(gid, "size", as.numeric(param_value(params, c("size"), 3))),
    alpha = latest_numeric(gid, "alpha", as.numeric(param_value(params, c("alpha"), 1))),
    linestyle = latest_string(gid, "linestyle", as_hex_or_fallback(param_value(params, c("linetype")), "solid"))
  )
  props
}

apply_layer_edits <- function(plot_obj) {
  if (!inherits(plot_obj, "ggplot")) return(plot_obj)
  if (length(plot_obj$layers) == 0) return(plot_obj)

  for (i in seq_along(plot_obj$layers)) {
    gid <- paste0("r.layer.", i - 1)
    params <- plot_obj$layers[[i]]$aes_params
    if (is.null(params)) params <- list()

    if (has_edit(gid, "color")) {
      params$colour <- latest_string(gid, "color", params$colour %||% "#1F77B4")
    }
    if (has_edit(gid, "facecolor")) {
      params$fill <- latest_string(gid, "facecolor", params$fill %||% "#1F77B4")
    }
    if (has_edit(gid, "box_color")) {
      params$fill <- latest_string(gid, "box_color", params$fill %||% "#1F77B4")
    }
    if (has_edit(gid, "edgecolor")) {
      params$colour <- latest_string(gid, "edgecolor", params$colour %||% "#000000")
    }
    if (has_edit(gid, "median_color")) {
      # ggplot2 does not expose a stable per-layer median-line colour for every
      # version, so this maps to the boxplot outline colour rather than faking
      # unsupported per-segment editing.
      params$colour <- latest_string(gid, "median_color", params$colour %||% "#000000")
    }
    if (has_edit(gid, "linewidth")) {
      line_width <- latest_numeric(gid, "linewidth", params$linewidth %||% params$size %||% 1)
      params$linewidth <- line_width
      params$size <- line_width
    }
    if (has_edit(gid, "size")) {
      params$size <- latest_numeric(gid, "size", params$size %||% 3)
    }
    if (has_edit(gid, "alpha")) {
      params$alpha <- latest_numeric(gid, "alpha", params$alpha %||% 1)
    }
    if (has_edit(gid, "linestyle")) {
      params$linetype <- latest_string(gid, "linestyle", params$linetype %||% "solid")
    }

    plot_obj$layers[[i]]$aes_params <- params
  }
  plot_obj
}

text_layer_rows <- function(plot_obj) {
  rows <- list()
  if (!inherits(plot_obj, "ggplot") || length(plot_obj$layers) == 0) return(rows)
  built <- tryCatch(ggplot2::ggplot_build(plot_obj), error = function(e) NULL)
  if (is.null(built) || is.null(built$data)) return(rows)

  for (i in seq_along(plot_obj$layers)) {
    geom <- geom_class(plot_obj$layers[[i]])
    if (!geom %in% c("GeomText", "GeomLabel")) next
    data <- built$data[[i]]
    if (is.null(data) || nrow(data) == 0) next
    source_data <- plot_obj$layers[[i]]$data
    if (is.null(source_data) || inherits(source_data, "waiver")) source_data <- plot_obj$data
    source_data <- tryCatch(as.data.frame(source_data), error = function(e) NULL)
    stable_keys <- NULL
    stable_key_source <- NULL
    if (!is.null(source_data) && nrow(source_data) == nrow(data)) {
      key_candidates <- c(".scifigure_id", "scifigure_id", "id", "ID", "key", "label_id")
      for (key_name in key_candidates) {
        if (!key_name %in% names(source_data)) next
        values <- as.character(source_data[[key_name]])
        if (length(values) == nrow(data) && all(!is.na(values) & nzchar(values)) && length(unique(values)) == length(values)) {
          stable_keys <- values
          stable_key_source <- if (identical(key_name, ".scifigure_id") && all(startsWith(values, "semantic:"))) "derived" else "source"
          break
        }
      }
    }
    if (is.null(stable_keys)) {
      derived_keys <- vapply(seq_len(nrow(data)), function(row_index) {
        row <- data[row_index, , drop = FALSE]
        identity_payload <- list(
          panel = as.character(row$PANEL %||% 1),
          x = as.character(row$x %||% ""),
          y = as.character(row$y %||% ""),
          label = as.character(row$label %||% "")
        )
        canonical <- jsonlite::toJSON(identity_payload, auto_unbox = TRUE, null = "null", digits = NA)
        encoded <- jsonlite::base64_enc(charToRaw(enc2utf8(canonical)))
        paste0("semantic:", gsub("[+/=]", "_", encoded, perl = TRUE))
      }, character(1))
      if (length(derived_keys) == nrow(data) && all(nzchar(derived_keys)) && length(unique(derived_keys)) == length(derived_keys)) {
        stable_keys <- derived_keys
        stable_key_source <- "derived"
      }
    }
    for (row_index in seq_len(nrow(data))) {
      rows[[length(rows) + 1]] <- list(
        layerIndex = i,
        rowIndex = row_index,
        geom = geom,
        dataKey = if (!is.null(stable_keys)) stable_keys[[row_index]] else NULL,
        dataKeySource = stable_key_source,
        data = data[row_index, , drop = FALSE]
      )
    }
  }
  rows
}

text_data_key_token <- function(value) {
  if (is.null(value) || length(value) == 0 || is.na(value[[1]]) || !nzchar(as.character(value[[1]]))) return(NULL)
  encoded <- jsonlite::base64_enc(charToRaw(enc2utf8(as.character(value[[1]]))))
  paste0("k", gsub("[+/=]", "_", encoded, perl = TRUE))
}

text_row_gid <- function(item) {
  token <- text_data_key_token(item$dataKey)
  if (!is.null(token) && !identical(item$dataKeySource, "derived")) {
    return(paste0("r.text.", item$layerIndex - 1, ".", token))
  }
  paste0("r.text.", item$layerIndex - 1, ".", item$rowIndex - 1)
}

text_row_legacy_gid <- function(item) {
  paste0("r.text.", item$layerIndex - 1, ".", item$rowIndex - 1)
}

text_row_edit_gid <- function(item) {
  stable_gid <- text_row_gid(item)
  legacy_gid <- text_row_legacy_gid(item)
  props <- c("text", "fontsize", "fontfamily", "fontweight", "fontstyle", "color", "position")
  if (any(vapply(props, function(prop) has_edit(stable_gid, prop), logical(1)))) return(stable_gid)
  if (!identical(stable_gid, legacy_gid) && any(vapply(props, function(prop) has_edit(legacy_gid, prop), logical(1)))) return(legacy_gid)
  stable_gid
}

panel_ranges <- function(plot_obj) {
  ranges <- list()
  built <- tryCatch(ggplot2::ggplot_build(plot_obj), error = function(e) NULL)
  if (is.null(built) || is.null(built$data)) return(ranges)
  for (data in built$data) {
    if (is.null(data) || nrow(data) == 0 || !"PANEL" %in% names(data)) next
    for (panel in unique(data$PANEL)) {
      key <- as.character(panel)
      sub <- data[data$PANEL == panel, , drop = FALSE]
      x_vals <- suppressWarnings(as.numeric(sub$x))
      y_vals <- suppressWarnings(as.numeric(sub$y))
      x_vals <- x_vals[is.finite(x_vals)]
      y_vals <- y_vals[is.finite(y_vals)]
      if (length(x_vals) == 0 || length(y_vals) == 0) next
      if (is.null(ranges[[key]])) {
        ranges[[key]] <- list(xmin = min(x_vals), xmax = max(x_vals), ymin = min(y_vals), ymax = max(y_vals))
      } else {
        ranges[[key]]$xmin <- min(ranges[[key]]$xmin, x_vals)
        ranges[[key]]$xmax <- max(ranges[[key]]$xmax, x_vals)
        ranges[[key]]$ymin <- min(ranges[[key]]$ymin, y_vals)
        ranges[[key]]$ymax <- max(ranges[[key]]$ymax, y_vals)
      }
    }
  }
  ranges
}

axis_limits_from_build <- function(plot_obj, axis_name = "x", panel_index = 1) {
  built <- tryCatch(ggplot2::ggplot_build(plot_obj), error = function(e) NULL)
  if (is.null(built) || is.null(built$layout) || is.null(built$layout$panel_params)) return(NULL)
  if (length(built$layout$panel_params) < panel_index) return(NULL)
  params <- built$layout$panel_params[[panel_index]]
  candidates <- if (identical(axis_name, "x")) {
    list(params$x.range, params$x$continuous_range, params$x.range %||% NULL)
  } else {
    list(params$y.range, params$y$continuous_range, params$y.range %||% NULL)
  }
  for (candidate in candidates) {
    vals <- suppressWarnings(as.numeric(candidate))
    vals <- vals[is.finite(vals)]
    if (length(vals) >= 2) return(as.list(vals[1:2]))
  }
  NULL
}

axis_breaks_from_build <- function(plot_obj, axis_name = "x", panel_index = 1) {
  built <- tryCatch(ggplot2::ggplot_build(plot_obj), error = function(e) NULL)
  if (is.null(built) || is.null(built$layout) || is.null(built$layout$panel_params)) return(numeric())
  if (length(built$layout$panel_params) < panel_index) return(numeric())
  params <- built$layout$panel_params[[panel_index]]
  axis_param <- if (identical(axis_name, "x")) params$x else params$y
  breaks <- NULL
  if (is.list(axis_param) || is.environment(axis_param)) {
    if (!is.null(axis_param$get_breaks)) {
      breaks <- tryCatch(axis_param$get_breaks(), error = function(e) NULL)
    }
    if (is.null(breaks)) breaks <- axis_param$breaks
    if (is.null(breaks)) breaks <- axis_param$major_source
  }
  values <- suppressWarnings(as.numeric(breaks))
  values <- values[is.finite(values)]
  if (length(values) > 0) return(values)
  limits <- axis_limits_from_build(plot_obj, axis_name, panel_index)
  limit_values <- suppressWarnings(as.numeric(limits))
  limit_values <- limit_values[is.finite(limit_values)]
  if (length(limit_values) >= 2) return(pretty(range(limit_values), n = 5))
  numeric()
}

text_position_context <- function(plot_obj) {
  built <- tryCatch(ggplot2::ggplot_build(plot_obj), error = function(e) NULL)
  list(
    built = built,
    coord = plot_obj$coordinates %||% NULL,
    panelParams = built$layout$panel_params %||% list(),
    builtPlot = built$plot %||% plot_obj
  )
}

position_scale_transform <- function(context, axis_name) {
  scale_obj <- tryCatch(context$builtPlot$scales$get_scales(axis_name), error = function(e) NULL)
  if (is.null(scale_obj) || is.null(scale_obj$trans)) {
    return(list(scale = scale_obj, name = "identity", inverse = function(value) value))
  }
  trans_name <- as.character(scale_obj$trans$name %||% "identity")
  inverse <- scale_obj$trans$inverse %||% function(value) value
  list(scale = scale_obj, name = trans_name, inverse = inverse)
}

text_position_support <- function(plot_obj, context = text_position_context(plot_obj)) {
  coord_classes <- class(context$coord)
  unsafe_coord <- intersect(coord_classes, c("CoordTrans", "CoordSf", "CoordMap", "CoordQuickmap"))
  if (length(unsafe_coord) > 0) {
    return(list(
      supported = FALSE,
      reason = paste0("Text dragging disabled for ggplot coordinate system: ", unsafe_coord[[1]])
    ))
  }

  if (!any(coord_classes %in% c("CoordCartesian", "CoordFlip", "CoordPolar"))) {
    return(list(supported = FALSE, reason = "Text dragging disabled because the ggplot coordinate transform is not affine and invertible."))
  }
  if ("CoordPolar" %in% coord_classes) {
    valid_polar <- length(context$panelParams) > 0 && all(vapply(context$panelParams, function(params) {
      length(params$theta.range %||% numeric()) >= 2 && length(params$r.range %||% numeric()) >= 2
    }, logical(1)))
    if (!valid_polar) return(list(supported = FALSE, reason = "Text dragging disabled because ggplot polar ranges are unavailable."))
  }

  supported_transforms <- c("identity", "none", "log-10", "log2", "log", "ln")
  for (axis_name in c("x", "y")) {
    transform <- position_scale_transform(context, axis_name)
    if (!transform$name %in% supported_transforms || !is.function(transform$inverse)) {
      return(list(
        supported = FALSE,
        reason = paste0("Text dragging disabled for transformed ggplot position scale: ", transform$name)
      ))
    }
  }

  list(supported = TRUE, reason = NULL, context = context)
}

coord_to_axes_fraction <- function(context, panel_index, x, y) {
  if (is.null(context$coord) || length(context$panelParams) < panel_index) return(NULL)
  transformed <- tryCatch(
    context$coord$transform(
      data.frame(x = as.numeric(x), y = as.numeric(y)),
      context$panelParams[[panel_index]]
    ),
    error = function(e) NULL
  )
  if (is.null(transformed) || !all(c("x", "y") %in% names(transformed))) return(NULL)
  next_x <- suppressWarnings(as.numeric(transformed$x[[1]]))
  next_y <- suppressWarnings(as.numeric(transformed$y[[1]]))
  if (!is.finite(next_x) || !is.finite(next_y)) return(NULL)
  list(x = next_x, y = next_y)
}

coord_from_axes_fraction <- function(context, panel_index, x_frac, y_frac, current_x = NULL, current_y = NULL) {
  if (is.null(context$coord) || length(context$panelParams) < panel_index) return(NULL)
  if (inherits(context$coord, "CoordPolar")) {
    params <- context$panelParams[[panel_index]]
    theta_range <- suppressWarnings(as.numeric(params$theta.range))
    r_range <- suppressWarnings(as.numeric(params$r.range))
    if (length(theta_range) < 2 || length(r_range) < 2 || any(!is.finite(c(theta_range, r_range)))) return(NULL)
    dx <- as.numeric(x_frac) - 0.5
    dy <- as.numeric(y_frac) - 0.5
    radius <- sqrt(dx * dx + dy * dy)
    if (!is.finite(radius) || radius > 0.400001) return(NULL)
    theta_angle <- if (radius < 1e-12 && !is.null(current_x) && !is.null(current_y)) {
      current <- coord_to_axes_fraction(context, panel_index, current_x, current_y)
      if (is.null(current)) 0 else atan2(current$x - 0.5, current$y - 0.5)
    } else {
      atan2(dx, dy)
    }
    start <- as.numeric(context$coord$start %||% 0)
    direction <- as.numeric(context$coord$direction %||% 1)
    normalized_theta <- ((theta_angle - start) * direction) %% (2 * pi)
    normalized_theta <- normalized_theta / (2 * pi)
    theta_value <- theta_range[[1]] + normalized_theta * (theta_range[[2]] - theta_range[[1]])
    r_value <- r_range[[1]] + (radius / 0.4) * (r_range[[2]] - r_range[[1]])
    if (identical(as.character(context$coord$theta %||% "x"), "y")) {
      return(list(x = r_value, y = theta_value))
    }
    return(list(x = theta_value, y = r_value))
  }
  samples <- tryCatch(
    context$coord$transform(
      data.frame(x = c(0, 1, 0), y = c(0, 0, 1)),
      context$panelParams[[panel_index]]
    ),
    error = function(e) NULL
  )
  if (is.null(samples) || nrow(samples) < 3 || !all(c("x", "y") %in% names(samples))) return(NULL)
  origin <- c(as.numeric(samples$x[[1]]), as.numeric(samples$y[[1]]))
  matrix_a <- matrix(c(
    as.numeric(samples$x[[2]]) - origin[[1]],
    as.numeric(samples$y[[2]]) - origin[[2]],
    as.numeric(samples$x[[3]]) - origin[[1]],
    as.numeric(samples$y[[3]]) - origin[[2]]
  ), nrow = 2, ncol = 2)
  target <- c(as.numeric(x_frac) - origin[[1]], as.numeric(y_frac) - origin[[2]])
  solved <- tryCatch(solve(matrix_a, target), error = function(e) NULL)
  if (is.null(solved) || length(solved) < 2 || any(!is.finite(solved))) return(NULL)
  list(x = as.numeric(solved[[1]]), y = as.numeric(solved[[2]]))
}

inverse_text_position_scales <- function(layer_data, context) {
  for (axis_name in c("x", "y")) {
    if (!axis_name %in% names(layer_data)) next
    transform <- position_scale_transform(context, axis_name)
    if (transform$name %in% c("identity", "none") || !is.function(transform$inverse)) next
    values <- suppressWarnings(as.numeric(layer_data[[axis_name]]))
    inverted <- tryCatch(transform$inverse(values), error = function(e) NULL)
    if (!is.null(inverted) && length(inverted) == length(values)) {
      layer_data[[axis_name]] <- inverted
    }
  }
  layer_data
}

to_axes_fraction <- function(x, y, range) {
  if (is.null(range)) return(list(x = as.numeric(x), y = as.numeric(y)))
  x_span <- range$xmax - range$xmin
  y_span <- range$ymax - range$ymin
  if (!is.finite(x_span) || x_span == 0 || !is.finite(y_span) || y_span == 0) {
    return(list(x = as.numeric(x), y = as.numeric(y)))
  }
  list(
    x = (as.numeric(x) - range$xmin) / x_span,
    y = (as.numeric(y) - range$ymin) / y_span
  )
}

from_axes_fraction <- function(x_frac, y_frac, range) {
  if (is.null(range)) return(list(x = as.numeric(x_frac), y = as.numeric(y_frac)))
  x_span <- range$xmax - range$xmin
  y_span <- range$ymax - range$ymin
  if (!is.finite(x_span) || x_span == 0 || !is.finite(y_span) || y_span == 0) {
    return(list(x = as.numeric(x_frac), y = as.numeric(y_frac)))
  }
  list(
    x = range$xmin + as.numeric(x_frac) * x_span,
    y = range$ymin + as.numeric(y_frac) * y_span
  )
}

latest_axes_position <- function(gid, fallback_x, fallback_y) {
  pos <- latest_value(gid, "position", NULL)
  if (is.list(pos)) {
    coord_system <- "axes"
    if (!is.null(pos$coord_system) && length(pos$coord_system) > 0) {
      coord_system <- as.character(pos$coord_system[[1]])
    }
    next_x <- if (!is.null(pos$x) && length(pos$x) > 0) suppressWarnings(as.numeric(pos$x[[1]])) else NA_real_
    next_y <- if (!is.null(pos$y) && length(pos$y) > 0) suppressWarnings(as.numeric(pos$y[[1]])) else NA_real_
    if (identical(coord_system, "axes")) {
      return(list(
        x = if (is.finite(next_x)) next_x else fallback_x,
        y = if (is.finite(next_y)) next_y else fallback_y
      ))
    }
    if (identical(coord_system, "data")) {
      return(list(
        x = fallback_x,
        y = fallback_y
      ))
    }
  }
  list(x = fallback_x, y = fallback_y)
}

extract_position_value <- function(pos) {
  if (!is.list(pos)) return(NULL)
  coord_system <- "data"
  if (!is.null(pos$coord_system) && length(pos$coord_system) > 0) {
    coord_system <- as.character(pos$coord_system[[1]])
  }
  next_x <- if (!is.null(pos$x) && length(pos$x) > 0) suppressWarnings(as.numeric(pos$x[[1]])) else NA_real_
  next_y <- if (!is.null(pos$y) && length(pos$y) > 0) suppressWarnings(as.numeric(pos$y[[1]])) else NA_real_
  list(x = next_x, y = next_y, coord_system = coord_system)
}

text_fontface_to_weight_style <- function(fontface) {
  face <- suppressWarnings(as.integer(fontface %||% 1))
  if (is.na(face)) face <- 1
  if (face == 2) return(list(fontweight = "bold", fontstyle = "normal"))
  if (face == 3) return(list(fontweight = "normal", fontstyle = "italic"))
  if (face == 4) return(list(fontweight = "bold", fontstyle = "italic"))
  list(fontweight = "normal", fontstyle = "normal")
}

weight_style_to_fontface <- function(weight, style) {
  is_bold <- weight %in% c("bold", "semibold", "700")
  is_italic <- style %in% c("italic", "oblique")
  if (is_bold && is_italic) return(4)
  if (is_bold) return(2)
  if (is_italic) return(3)
  1
}

apply_text_layer_edits <- function(plot_obj) {
  rows <- text_layer_rows(plot_obj)
  if (length(rows) == 0) return(plot_obj)
  position_context <- text_position_context(plot_obj)
  position_support <- text_position_support(plot_obj, position_context)

  edited_by_layer <- list()
  for (item in rows) {
    gid <- text_row_edit_gid(item)
    if (
      !has_edit(gid, "text") &&
      !has_edit(gid, "fontsize") &&
      !has_edit(gid, "fontfamily") &&
      !has_edit(gid, "fontweight") &&
      !has_edit(gid, "fontstyle") &&
      !has_edit(gid, "color") &&
      !has_edit(gid, "position")
    ) {
      next
    }

    layer_key <- as.character(item$layerIndex)
    if (is.null(edited_by_layer[[layer_key]])) {
      layer_data <- ggplot2::ggplot_build(plot_obj)$data[[item$layerIndex]]
      layer_items <- Filter(function(candidate) candidate$layerIndex == item$layerIndex, rows)
      layer_keys <- vapply(layer_items, function(candidate) as.character(candidate$dataKey %||% ""), character(1))
      if (length(layer_keys) == nrow(layer_data) && all(nzchar(layer_keys))) {
        layer_data$.scifigure_id <- layer_keys
      }
      edited_by_layer[[layer_key]] <- layer_data
    }
    layer_data <- edited_by_layer[[layer_key]]
    row_index <- item$rowIndex
    row <- layer_data[row_index, , drop = FALSE]

    if (has_edit(gid, "text")) {
      row$label <- latest_string(gid, "text", as.character(row$label %||% ""))
    }
    if (has_edit(gid, "fontsize")) {
      row$size <- latest_numeric(gid, "fontsize", row$size %||% 4)
    }
    if (has_edit(gid, "fontfamily")) {
      row$family <- latest_string(gid, "fontfamily", row$family %||% "")
    }
    if (has_edit(gid, "color")) {
      row$colour <- latest_string(gid, "color", row$colour %||% "black")
    }
    if (has_edit(gid, "fontweight") || has_edit(gid, "fontstyle")) {
      face <- text_fontface_to_weight_style(row$fontface %||% 1)
      weight <- latest_string(gid, "fontweight", face$fontweight)
      style <- latest_string(gid, "fontstyle", face$fontstyle)
      row$fontface <- weight_style_to_fontface(weight, style)
    }
    if (has_edit(gid, "position")) {
      if (!isTRUE(position_support$supported)) {
        warning_message <- position_support$reason %||% "Text position patch ignored for unsupported ggplot coordinate system."
        add_warning_once(warning_message)
        add_patch_warning_once("unsupported_coordinate", gid, "position", warning_message)
      } else {
        pos <- extract_position_value(latest_value(gid, "position", NULL))
        if (!is.null(pos)) {
          next_x <- pos$x
          next_y <- pos$y
          coord_system <- pos$coord_system
          if (coord_system == "axes") {
            panel_index <- as.integer(row$PANEL %||% 1)
            converted <- coord_from_axes_fraction(position_context, panel_index, next_x, next_y, row$x, row$y)
            if (is.null(converted)) {
              warning_message <- "Text position patch ignored because the ggplot affine coordinate transform could not be inverted."
              add_warning_once(warning_message)
              add_patch_warning_once("no_setter", gid, "position", warning_message)
              next_x <- NA_real_
              next_y <- NA_real_
            } else {
              next_x <- converted$x
              next_y <- converted$y
            }
          } else if (coord_system == "data") {
            for (axis_name in c("x", "y")) {
              transform <- position_scale_transform(position_context, axis_name)
              value <- if (axis_name == "x") next_x else next_y
              if (!transform$name %in% c("identity", "none") && !is.null(transform$scale$trans$transform)) {
                value <- tryCatch(transform$scale$trans$transform(value), error = function(e) NA_real_)
              }
              if (axis_name == "x") next_x <- value else next_y <- value
            }
          }
          if (is.finite(next_x)) row$x <- next_x
          if (is.finite(next_y)) row$y <- next_y
        }
      }
    }

    layer_data[row_index, names(row)] <- row
    edited_by_layer[[layer_key]] <- layer_data
  }

  if (length(edited_by_layer) == 0) return(plot_obj)

  for (layer_key in names(edited_by_layer)) {
    layer_index <- as.integer(layer_key)
    source_layer <- plot_obj$layers[[layer_index]]
    geom <- geom_class(source_layer)
    frozen_identity_key <- source_layer$.scifigure_identity_key %||%
      r_layer_structure_signature(source_layer, plot_obj$mapping)
    layer_data <- inverse_text_position_scales(edited_by_layer[[layer_key]], position_context)
    keep_cols <- intersect(
      c(".scifigure_id", "x", "y", "label", "colour", "color", "size", "alpha", "family", "fontface", "angle", "hjust", "vjust", "lineheight"),
      names(layer_data)
    )
    layer_data <- layer_data[, keep_cols, drop = FALSE]
    names(layer_data)[names(layer_data) == "colour"] <- "colour"
    if (geom == "GeomLabel") {
      replacement_layer <- ggplot2::geom_label(
        data = layer_data,
        mapping = ggplot2::aes(x = x, y = y, label = label),
        inherit.aes = FALSE,
        colour = layer_data$colour %||% layer_data$color %||% "black",
        size = layer_data$size %||% 4,
        family = layer_data$family %||% "",
        fontface = layer_data$fontface %||% 1,
        alpha = layer_data$alpha %||% NA
      )
    } else {
      replacement_layer <- ggplot2::geom_text(
        data = layer_data,
        mapping = ggplot2::aes(x = x, y = y, label = label),
        inherit.aes = FALSE,
        colour = layer_data$colour %||% layer_data$color %||% "black",
        size = layer_data$size %||% 4,
        family = layer_data$family %||% "",
        fontface = layer_data$fontface %||% 1,
        alpha = layer_data$alpha %||% NA
      )
    }
    replacement_layer$.scifigure_identity_key <- frozen_identity_key
    plot_obj$layers[[layer_index]] <- replacement_layer
  }

  plot_obj
}

scale_palette_values <- function(scale_obj) {
  values <- scale_obj$palette.cache
  if ((is.null(values) || length(values) == 0) && !is.null(scale_obj$palette)) {
    range_values <- scale_obj$range$range %||% character()
    n <- max(1L, length(range_values))
    values <- tryCatch(scale_obj$palette(n), error = function(e) NULL)
  }
  if (is.null(values) || length(values) == 0) return(NULL)
  values <- values[!is.na(values)]
  if (length(values) == 0) return(NULL)
  values
}

scale_kind <- function(scale_obj) {
  aesthetics <- scale_obj$aesthetics %||% character()
  if (any(aesthetics %in% c("colour", "color"))) return("color")
  if (any(aesthetics %in% c("fill"))) return("fill")
  NULL
}

legend_title_from_scale <- function(plot_obj) {
  scale_lists <- list(plot_obj$scales$scales %||% list())
  built <- tryCatch(ggplot2::ggplot_build(plot_obj), error = function(e) NULL)
  if (!is.null(built) && !is.null(built$plot) && !is.null(built$plot$scales)) {
    scale_lists[[length(scale_lists) + 1]] <- built$plot$scales$scales %||% list()
  }
  for (scale_list in scale_lists) {
    for (scale_obj in scale_list) {
      if (is.null(scale_kind(scale_obj))) next
      scale_name <- scale_obj$name
      if (is.null(scale_name) || inherits(scale_name, "waiver") || length(scale_name) == 0) next
      value <- as.character(scale_name[[1]])
      if (!is.na(value) && nzchar(value)) return(value)
    }
  }
  as.character(plot_obj$labels$colour %||% plot_obj$labels$color %||% plot_obj$labels$fill %||% "")
}

is_position_scale <- function(scale_obj) {
  aesthetics <- scale_obj$aesthetics %||% character()
  any(aesthetics %in% c("x", "y", "xmin", "xmax", "ymin", "ymax"))
}

is_continuous_colour_scale <- function(scale_obj) {
  any(class(scale_obj) %in% c("ScaleContinuous", "ScaleContinuousIdentity")) &&
    !is_position_scale(scale_obj) &&
    !is.null(scale_kind(scale_obj))
}

cmap_colors <- function(cmap) {
  cmap <- as.character(cmap %||% "viridis")
  switch(
    cmap,
    viridis = c("#440154", "#31688E", "#35B779", "#FDE725"),
    plasma = c("#0D0887", "#9C179E", "#ED7953", "#F0F921"),
    inferno = c("#000004", "#781C6D", "#ED6925", "#FCFFA4"),
    magma = c("#000004", "#721F81", "#F1605D", "#FCFDBF"),
    cividis = c("#00224E", "#575D6D", "#A59C74", "#FDE725"),
    coolwarm = c("#3B4CC0", "#FFFFFF", "#B40426"),
    seismic = c("#0000A3", "#FFFFFF", "#A30000"),
    bwr = c("#0000FF", "#FFFFFF", "#FF0000"),
    gray = c("#000000", "#FFFFFF"),
    grey = c("#000000", "#FFFFFF"),
    hot = c("#000000", "#FF0000", "#FFFF00", "#FFFFFF"),
    jet = c("#00007F", "#007FFF", "#7FFF7F", "#FF7F00", "#7F0000"),
    rainbow = grDevices::rainbow(7),
    c("#440154", "#31688E", "#35B779", "#FDE725")
  )
}

sample_scale_colors <- function(scale_obj, fallback = "viridis") {
  values <- tryCatch(scale_obj$palette(seq(0, 1, length.out = 7)), error = function(e) NULL)
  if (is.null(values) || length(values) == 0 || any(is.na(values))) {
    return(cmap_colors(fallback))
  }
  as.character(values)
}

continuous_limits <- function(scale_obj) {
  limits <- scale_obj$limits
  if (!is.null(limits) && !is.function(limits) && length(limits) >= 2) {
    return(c(suppressWarnings(as.numeric(limits[[1]])), suppressWarnings(as.numeric(limits[[2]]))))
  }
  range_values <- suppressWarnings(as.numeric(scale_obj$range$range %||% c(NA, NA)))
  if (length(range_values) >= 2 && all(is.finite(range_values))) {
    return(range(range_values, na.rm = TRUE))
  }
  c(NA_real_, NA_real_)
}

find_continuous_colour_scales <- function(plot_obj) {
  built_plot <- tryCatch(ggplot2::ggplot_build(plot_obj)$plot, error = function(e) plot_obj)
  scales <- list()
  if (is.null(built_plot$scales) || length(built_plot$scales$scales) == 0) return(scales)
  for (scale_index in seq_along(built_plot$scales$scales)) {
    scale_obj <- built_plot$scales$scales[[scale_index]]
    if (is_continuous_colour_scale(scale_obj)) {
      scales[[length(scales) + 1]] <- list(index = scale_index - 1, scale = scale_obj, kind = scale_kind(scale_obj))
    }
  }
  scales
}

r_aesthetic_mapping_signature <- function(plot_obj, kind) {
  aliases <- if (identical(kind, "color")) c("colour", "color") else kind
  signatures <- character()
  collect_mapping <- function(mapping) {
    if (is.null(mapping) || length(mapping) == 0) return()
    for (alias in aliases) {
      if (!is.null(mapping[[alias]])) signatures <<- c(signatures, r_expression_label(mapping[[alias]]))
    }
  }
  collect_mapping(plot_obj$mapping)
  for (layer in plot_obj$layers %||% list()) {
    collect_mapping(r_effective_layer_mapping(layer, plot_obj$mapping))
  }
  signatures <- sort(unique(signatures[nzchar(signatures)]))
  if (length(signatures) == 0) return(paste0("unmapped-", kind))
  paste(signatures, collapse = "\u001f")
}

r_scale_structure_key <- function(scale_obj, kind, keys = character(), mapping_key = "") {
  scale_classes <- paste(class(scale_obj), collapse = "/")
  transform_name <- as.character(scale_obj$trans$name %||% "identity")
  canonical_keys <- paste(sort(unique(as.character(keys))), collapse = "\u001f")
  paste("ggplot-scale", kind, mapping_key, scale_classes, transform_name, canonical_keys, sep = ":")
}

r_guide_title_signature <- function(scale_obj, plot_obj, kind, mapping_key) {
  guide_obj <- scale_obj$guide %||% NULL
  guide_title <- if (is.list(guide_obj) || is.environment(guide_obj)) guide_obj$title %||% NULL else NULL
  scale_title <- scale_obj$name %||% NULL
  title <- guide_title
  if (is.null(title) || inherits(title, "waiver") || !nzchar(r_expression_label(title))) title <- scale_title
  if (is.null(title) || inherits(title, "waiver") || !nzchar(r_expression_label(title))) {
    aliases <- if (identical(kind, "color")) c("colour", "color") else kind
    for (alias in aliases) {
      candidate <- plot_obj$labels[[alias]] %||% NULL
      if (!is.null(candidate) && nzchar(r_expression_label(candidate))) {
        title <- candidate
        break
      }
    }
  }
  resolved <- r_expression_label(title)
  if (!nzchar(resolved)) resolved <- mapping_key
  gsub("[\r\n\t ]+", " ", resolved, perl = TRUE)
}

r_guide_type_signature <- function(scale_obj) {
  guide_obj <- scale_obj$guide %||% NULL
  if (is.null(guide_obj) || inherits(guide_obj, "waiver")) return("legend")
  if (is.character(guide_obj)) return(paste(guide_obj, collapse = "+"))
  classes <- class(guide_obj)
  if (length(classes) == 0) return("legend")
  paste(classes, collapse = "/")
}

discrete_scale_catalog <- function(plot_obj) {
  built <- tryCatch(ggplot2::ggplot_build(plot_obj), error = function(e) NULL)
  built_plot <- if (!is.null(built) && !is.null(built$plot)) built$plot else plot_obj
  scale_list <- built_plot$scales$scales %||% list()
  entries <- list()
  kind_ordinals <- list(color = 0L, fill = 0L)

  for (scale_index in seq_along(scale_list)) {
    scale_obj <- scale_list[[scale_index]]
    kind <- scale_kind(scale_obj)
    if (is.null(kind) || is_continuous_colour_scale(scale_obj)) next

    keys <- tryCatch(scale_obj$get_limits(), error = function(e) NULL)
    if (is.null(keys) || length(keys) == 0) keys <- scale_obj$range$range %||% character()
    keys <- as.character(keys)
    keys <- keys[!is.na(keys) & nzchar(keys)]
    if (length(keys) == 0) next

    colors <- tryCatch(scale_obj$map(keys), error = function(e) NULL)
    if (is.null(colors) || length(colors) != length(keys) || any(is.na(colors))) {
      colors <- scale_palette_values(scale_obj)
    }
    if (is.null(colors) || length(colors) < length(keys)) next
    colors <- as.character(colors[seq_along(keys)])

    labels <- tryCatch(scale_obj$get_labels(keys), error = function(e) NULL)
    if (is.null(labels) || length(labels) != length(keys)) labels <- keys
    labels <- as.character(labels)
    labels[is.na(labels) | !nzchar(labels)] <- keys[is.na(labels) | !nzchar(labels)]

    ordinal <- kind_ordinals[[kind]] %||% 0L
    kind_ordinals[[kind]] <- ordinal + 1L
    mapping_key <- r_aesthetic_mapping_signature(built_plot, kind)
    scale_key <- r_scale_structure_key(scale_obj, kind, keys, mapping_key)
    guide_title_key <- r_guide_title_signature(scale_obj, built_plot, kind, mapping_key)
    guide_type_key <- r_guide_type_signature(scale_obj)
    guide_key <- paste(
      "ggplot-guide",
      mapping_key,
      guide_title_key,
      guide_type_key,
      paste(sort(unique(keys)), collapse = "\u001f"),
      sep = ":"
    )
    entries[[length(entries) + 1]] <- list(
      kind = kind,
      ordinal = ordinal,
      scaleIndex = scale_index,
      scaleId = paste0("r.scale.", kind, ".", ordinal),
      scaleKey = scale_key,
      guideKey = guide_key,
      guideTitleKey = guide_title_key,
      guideTypeKey = guide_type_key,
      mappingKey = mapping_key,
      scale = scale_obj,
      keys = keys,
      labels = labels,
      colors = colors
    )
  }

  list(entries = entries, builtData = built$data %||% list())
}

discrete_group_usage <- function(entry, item_index, built_data, plot_obj) {
  color <- entry$colors[[item_index]]
  value_column <- if (entry$kind == "fill") "fill" else "colour"
  layer_ids <- character()
  subplot_ids <- character()
  geoms <- character()

  for (layer_index in seq_along(built_data)) {
    data <- built_data[[layer_index]]
    if (is.null(data) || nrow(data) == 0 || !value_column %in% names(data)) next
    matches <- vapply(data[[value_column]], function(value) colors_equal(value, color), logical(1))
    if (!any(matches)) next
    layer_ids <- c(layer_ids, paste0("r.layer.", layer_index - 1))
    if (layer_index <= length(plot_obj$layers)) {
      geoms <- c(geoms, geom_class(plot_obj$layers[[layer_index]]))
    }
    if ("PANEL" %in% names(data)) {
      panels <- unique(as.integer(data$PANEL[matches]))
      panels <- panels[is.finite(panels)]
      subplot_ids <- c(subplot_ids, paste0("subplot.", panels - 1))
    }
  }

  semantic_kind <- if (any(geoms %in% c("GeomLine", "GeomPath", "GeomSmooth"))) {
    "line"
  } else if (identical(entry$kind, "fill")) {
    "bar"
  } else {
    "scatter"
  }
  duplicate_color <- sum(vapply(entry$colors, function(value) colors_equal(value, color), logical(1))) > 1
  list(
    layerIds = as.list(unique(layer_ids)),
    subplotIds = as.list(unique(subplot_ids)),
    semanticKind = semantic_kind,
    svgSelectable = !duplicate_color
  )
}

detect_discrete_scale_semantics <- function(plot_obj) {
  palettes <- list()
  bindings <- list()
  groups <- list()
  objects <- list()
  catalog <- discrete_scale_catalog(plot_obj)

  for (entry in catalog$entries) {
    kind <- entry$kind
    for (i in seq_along(entry$keys)) {
      palette_id <- paste0(entry$scaleId, ".", i - 1)
      group_id <- paste0("r.group.", kind, ".", entry$ordinal, ".", i - 1)
      color <- as.character(entry$colors[[i]])
      label <- as.character(entry$labels[[i]])
      group_key <- as.character(entry$keys[[i]])
      usage <- discrete_group_usage(entry, i, catalog$builtData, plot_obj)
      palettes[[length(palettes) + 1]] <- list(
        id = palette_id,
        label = label,
        color = latest_string(group_id, if (kind == "fill") "facecolor" else "color", color),
        source = paste0("ggplot discrete ", kind, " scale"),
        line = 0
      )
      groups[[length(groups) + 1]] <- list(
        groupId = group_id,
        label = label,
        paletteId = palette_id,
        kind = usage$semanticKind,
        aesthetic = kind,
        scaleId = entry$scaleId,
        layerIds = usage$layerIds,
        subplotIds = usage$subplotIds
      )
      objects[[length(objects) + 1]] <- list(
        id = group_id,
        kind = if (usage$semanticKind == "line") "line" else if (kind == "fill") "patch" else "collection",
        label = paste0(label, " (", kind, " scale)"),
        editable = list(if (kind == "fill") "facecolor" else "color"),
        currentProps = c(
          if (kind == "fill") list(facecolor = latest_string(group_id, "facecolor", color)) else list(color = latest_string(group_id, "color", color)),
          list(aesthetic = kind, groupKey = group_key, svgSelectable = usage$svgSelectable)
        ),
        role = paste0("ggplot_scale_", kind),
        layerIds = usage$layerIds,
        subplotIds = usage$subplotIds,
        scaleId = entry$scaleId,
        guideId = "legend.0",
        legendId = "legend.0",
        scaleKey = entry$scaleKey,
        guideKey = entry$guideKey,
        aesthetic = kind,
        groupKey = group_key,
        source = list(artistClass = "ggplot_scale_discrete", axesIndex = 0)
      )
      bindings[[length(bindings) + 1]] <- list(
        paletteId = palette_id,
        groupId = group_id,
        gids = list(group_id),
        props = list(if (kind == "fill") "facecolor" else "color"),
        targetMode = "exact",
        targets = list(list(
          gid = group_id,
          prop = if (kind == "fill") "facecolor" else "color",
          instanceKey = paste("r", "container", group_id, sep = ":"),
          seriesKey = paste("r-series", kind, group_key, sep = ":"),
          match = "scale_key",
          confidence = "exact"
        ))
      )
    }
  }
  list(palettes = palettes, bindings = bindings, groups = groups, objects = objects)
}

apply_discrete_scale_edits <- function(plot_obj) {
  catalog <- discrete_scale_catalog(plot_obj)
  if (length(catalog$entries) == 0) return(plot_obj)

  for (entry in catalog$entries) {
    kind <- entry$kind
    values <- entry$colors
    changed <- FALSE
    for (i in seq_along(values)) {
      group_id <- paste0("r.group.", kind, ".", entry$ordinal, ".", i - 1)
      prop <- if (kind == "fill") "facecolor" else "color"
      if (has_edit(group_id, prop)) {
        values[[i]] <- latest_string(group_id, prop, as.character(values[[i]]))
        changed <- TRUE
      }
    }
    if (changed) {
      names(values) <- entry$keys
      scale_args <- list(values = values, breaks = entry$keys, labels = entry$labels, limits = entry$keys)
      scale_name <- entry$scale$name
      if (!is.null(scale_name) && length(scale_name) > 0 && !inherits(scale_name, "waiver")) {
        scale_args$name <- scale_name
      }
      if (!is.null(entry$scale$na.value)) scale_args$na.value <- entry$scale$na.value
      if (!is.null(entry$scale$drop)) scale_args$drop <- entry$scale$drop
      if (!is.null(entry$scale$na.translate)) scale_args$na.translate <- entry$scale$na.translate
      if (!is.null(entry$scale$guide) && !inherits(entry$scale$guide, "waiver")) scale_args$guide <- entry$scale$guide
      if (kind == "fill") {
        plot_obj <- suppressMessages(plot_obj + do.call(ggplot2::scale_fill_manual, scale_args))
      } else {
        plot_obj <- suppressMessages(plot_obj + do.call(ggplot2::scale_color_manual, scale_args))
      }
    }
  }
  plot_obj
}

apply_continuous_scale_edits <- function(plot_obj) {
  if (!inherits(plot_obj, "ggplot")) return(plot_obj)
  continuous_scales <- find_continuous_colour_scales(plot_obj)
  if (length(continuous_scales) == 0) return(plot_obj)

  for (item in continuous_scales) {
    scale_obj <- item$scale
    kind <- item$kind
    scale_index <- item$index
    heatmap_gid <- paste0("r.heatmap.", kind, ".", scale_index)
    colorbar_gid <- paste0("r.colorbar.", kind, ".", scale_index)
    limits <- continuous_limits(scale_obj)
    current_vmin <- if (is.finite(limits[[1]])) limits[[1]] else NA_real_
    current_vmax <- if (is.finite(limits[[2]])) limits[[2]] else NA_real_
    current_label <- as.character(scale_obj$name %||% plot_obj$labels[[kind]] %||% kind)
    current_colors <- sample_scale_colors(scale_obj)

    scale_changed <- has_edit(heatmap_gid, "cmap") ||
      has_edit(heatmap_gid, "vmin") ||
      has_edit(heatmap_gid, "vmax") ||
      has_edit(heatmap_gid, "alpha")
    label_changed <- has_edit(colorbar_gid, "label")

    if (scale_changed || label_changed) {
      cmap <- latest_string(heatmap_gid, "cmap", "custom")
      colors <- if (has_edit(heatmap_gid, "cmap")) cmap_colors(cmap) else current_colors
      vmin <- latest_numeric(heatmap_gid, "vmin", current_vmin)
      vmax <- latest_numeric(heatmap_gid, "vmax", current_vmax)
      label <- latest_string(colorbar_gid, "label", current_label)
      scale_limits <- NULL
      if (is.finite(vmin) && is.finite(vmax)) {
        scale_limits <- c(vmin, vmax)
      }

      if (kind == "fill") {
        plot_obj <- suppressMessages(plot_obj + ggplot2::scale_fill_gradientn(colors = colors, limits = scale_limits, name = label))
      } else {
        plot_obj <- suppressMessages(plot_obj + ggplot2::scale_color_gradientn(colors = colors, limits = scale_limits, name = label))
      }
    }

    if (has_edit(heatmap_gid, "alpha")) {
      alpha <- latest_numeric(heatmap_gid, "alpha", 1)
      for (i in seq_along(plot_obj$layers)) {
        geom <- geom_class(plot_obj$layers[[i]])
        if (geom %in% c("GeomTile", "GeomRaster", "GeomRect")) {
          params <- plot_obj$layers[[i]]$aes_params
          if (is.null(params)) params <- list()
          params$alpha <- alpha
          plot_obj$layers[[i]]$aes_params <- params
        }
      }
    }

    if (has_edit(colorbar_gid, "tick_fontsize")) {
      tick_size <- latest_numeric(colorbar_gid, "tick_fontsize", default_legend$fontsize)
      plot_obj <- plot_obj + ggplot2::theme(legend.text = ggplot2::element_text(size = tick_size))
    }

    has_bounds_edit <- has_edit(colorbar_gid, "left") ||
      has_edit(colorbar_gid, "bottom") ||
      has_edit(colorbar_gid, "width") ||
      has_edit(colorbar_gid, "height")
    if (has_bounds_edit) {
      cb_left <- clamp_numeric(latest_numeric(colorbar_gid, "left", default_colorbar$left), 0, 1)
      cb_bottom <- clamp_numeric(latest_numeric(colorbar_gid, "bottom", default_colorbar$bottom), 0, 1)
      cb_width <- clamp_numeric(latest_numeric(colorbar_gid, "width", default_colorbar$width), 0.005, 1)
      cb_height <- clamp_numeric(latest_numeric(colorbar_gid, "height", default_colorbar$height), 0.01, 1)
      guide <- ggplot2::guide_colourbar(
        barwidth = grid::unit(cb_width * width, "in"),
        barheight = grid::unit(cb_height * height, "in")
      )
      if (kind == "fill") {
        plot_obj <- plot_obj + ggplot2::guides(fill = guide)
      } else {
        plot_obj <- plot_obj + ggplot2::guides(color = guide, colour = guide)
      }
      if (cb_left >= 0.65) {
        vertical_justification <- if (cb_bottom <= 0.35) {
          "bottom"
        } else if (cb_bottom + cb_height >= 0.80) {
          "top"
        } else {
          "center"
        }
        plot_obj <- plot_obj + ggplot2::theme(
          legend.position = "right",
          legend.box.just = vertical_justification,
          legend.box.spacing = grid::unit(0.12, "in")
        )
      } else {
        plot_obj <- plot_obj + ggplot2::theme(
          legend.position = c(cb_left, cb_bottom),
          legend.justification = c(0, 0)
        )
      }
    }

    if (has_edit(colorbar_gid, "visible")) {
      is_visible <- latest_bool(colorbar_gid, "visible", TRUE)
      if (!is_visible) {
        if (kind == "fill") {
          plot_obj <- plot_obj + ggplot2::guides(fill = "none")
        } else {
          plot_obj <- plot_obj + ggplot2::guides(color = "none", colour = "none")
        }
      }
    }
  }

  plot_obj
}

apply_legend_text_edits <- function(plot_obj) {
  if (!inherits(plot_obj, "ggplot")) return(plot_obj)
  catalog <- discrete_scale_catalog(plot_obj)
  if (length(catalog$entries) == 0) return(plot_obj)
  semantic_items <- legend_item_semantics(plot_obj)
  if (length(semantic_items) == 0) return(plot_obj)

  for (entry in catalog$entries) {
    changed <- FALSE
    next_labels <- entry$labels
    for (i in seq_along(next_labels)) {
      merge_key <- paste(entry$guideKey, entry$keys[[i]], entry$labels[[i]], sep = ":")
      item_index <- which(vapply(
        semantic_items,
        function(item) identical(item$mergeKey, merge_key),
        logical(1)
      ))
      if (length(item_index) == 0) next
      gid <- paste0("legend_text.0.", item_index[[1]] - 1L)
      if (has_edit(gid, "text")) {
        next_labels[[i]] <- latest_string(gid, "text", next_labels[[i]])
        changed <- TRUE
      }
    }
    if (changed) {
      values <- entry$colors
      names(values) <- entry$keys
      scale_args <- list(
        values = values,
        breaks = entry$keys,
        labels = next_labels,
        limits = entry$keys
      )
      scale_name <- entry$scale$name
      if (!is.null(scale_name) && length(scale_name) > 0 && !inherits(scale_name, "waiver")) {
        scale_args$name <- scale_name
      }
      if (!is.null(entry$scale$na.value)) scale_args$na.value <- entry$scale$na.value
      if (!is.null(entry$scale$drop)) scale_args$drop <- entry$scale$drop
      if (!is.null(entry$scale$na.translate)) scale_args$na.translate <- entry$scale$na.translate
      if (!is.null(entry$scale$guide) && !inherits(entry$scale$guide, "waiver")) scale_args$guide <- entry$scale$guide
      if (entry$kind == "fill") {
        plot_obj <- suppressMessages(plot_obj + do.call(ggplot2::scale_fill_manual, scale_args))
      } else {
        plot_obj <- suppressMessages(plot_obj + do.call(ggplot2::scale_colour_manual, scale_args))
      }
    }
  }
  plot_obj
}

apply_ggplot_edits <- function(plot_obj) {
  if (!inherits(plot_obj, "ggplot")) return(plot_obj)

  title_text <- latest_string("title.0", "text", plot_obj$labels$title %||% "")
  x_text <- axis_label_text_for_gid("axis.x.0", "xlabel.0", plot_obj$labels$x %||% "")
  y_text <- axis_label_text_for_gid("axis.y.0", "ylabel.0", plot_obj$labels$y %||% "")
  legend_title <- latest_string(
    "legend_title.0",
    "text",
    latest_string("legend.0", "title", legend_title_from_scale(plot_obj))
  )

  title_style <- style_for_gid("title.0", default_title)
  x_label_style <- axis_label_style_for_gid("axis.x.0", "xlabel.0", default_label)
  y_label_style <- axis_label_style_for_gid("axis.y.0", "ylabel.0", default_label)
  x_tick_style <- axis_style_for_gid("axis.x.0", default_tick)
  y_tick_style <- axis_style_for_gid("axis.y.0", default_tick)
  legend_style <- style_for_gid("legend.0", default_legend)
  legend_title_style <- style_for_gid("legend_title.0", legend_style)
  legend_text_weight <- latest_prefixed_string("legend_text.0.", "fontweight", legend_style$fontweight)
  legend_text_style <- latest_prefixed_string("legend_text.0.", "fontstyle", legend_style$fontstyle)
  legend_item_style <- list(
    fontsize = latest_prefixed_numeric("legend_text.0.", "fontsize", legend_style$fontsize),
    fontfamily = latest_prefixed_string("legend_text.0.", "fontfamily", legend_style$fontfamily),
    color = latest_prefixed_string("legend_text.0.", "color", legend_style$color),
    fontweight = legend_text_weight,
    fontstyle = legend_text_style,
    face = font_face(legend_text_weight, legend_text_style)
  )
  strip_style <- style_for_gid("facet.strip.0", default_strip)

  grid_visible <- latest_bool("grid.0", "visible", TRUE)
  grid_color <- latest_string("grid.0", "color", "#E5E5E5")
  grid_width <- latest_numeric("grid.0", "linewidth", 0.5)
  grid_style_str <- latest_string("grid.0", "linestyle", "solid")
  grid_alpha <- latest_numeric("grid.0", "alpha", 1.0)

  x_spine_visible <- latest_bool("spine.bottom.0", "visible", TRUE)
  y_spine_visible <- latest_bool("spine.left.0", "visible", TRUE)
  top_spine_visible <- latest_bool("spine.top.0", "visible", TRUE)
  right_spine_visible <- latest_bool("spine.right.0", "visible", TRUE)

  x_spine_color <- latest_string("spine.bottom.0", "color", "black")
  y_spine_color <- latest_string("spine.left.0", "color", "black")
  x_spine_width <- latest_numeric("spine.bottom.0", "linewidth", 0.5)
  y_spine_width <- latest_numeric("spine.left.0", "linewidth", 0.5)

  border_color <- latest_string("spine.top.0", "color", latest_string("spine.right.0", "color", "black"))
  border_width <- latest_numeric("spine.top.0", "linewidth", latest_numeric("spine.right.0", "linewidth", 0.5))
  border_visible <- isTRUE(top_spine_visible) || isTRUE(right_spine_visible)

  legend_visible_bool <- latest_bool("legend.0", "visible", TRUE)
  legend_loc <- latest_string("legend.0", "loc", "right")
  r_legend_pos <- switch(
    legend_loc,
    `upper right` = "right",
    `lower right` = "right",
    `upper left` = "left",
    `lower left` = "left",
    `upper center` = "top",
    `lower center` = "bottom",
    center = "right",
    right = "right",
    left = "left",
    top = "top",
    bottom = "bottom",
    "right"
  )
  legend_face <- latest_string("legend.0", "facecolor", "white")
  legend_edge <- latest_string("legend.0", "edgecolor", "none")
  legend_lw <- latest_numeric("legend.0", "linewidth", 0.5)
  legend_alpha <- latest_numeric("legend.0", "alpha", 1.0)
  legend_ncol <- max(1L, as.integer(latest_numeric("legend.0", "ncol", default_legend$ncol)))
  legend_markerscale <- max(0.1, latest_numeric("legend.0", "markerscale", default_legend$markerscale))
  legend_handletextpad <- max(0, latest_numeric("legend.0", "handletextpad", default_legend$handletextpad))
  legend_labelspacing <- max(0, latest_numeric("legend.0", "labelspacing", default_legend$labelspacing))
  legend_columnspacing <- max(0, latest_numeric("legend.0", "columnspacing", default_legend$columnspacing))
  legend_borderpad <- max(0, latest_numeric("legend.0", "borderpad", default_legend$borderpad))
  legend_text_pad_pt <- legend_handletextpad * legend_item_style$fontsize
  legend_row_pad_pt <- legend_labelspacing * legend_item_style$fontsize / 2
  legend_column_pad_pt <- if (legend_ncol > 1) legend_columnspacing * legend_item_style$fontsize else 0
  legend_borderpad_pt <- legend_borderpad * legend_item_style$fontsize
  legend_face_effective <- if (legend_face == "none") "transparent" else alpha_color(legend_face, legend_alpha)
  legend_edge_effective <- if (legend_edge == "none") "transparent" else alpha_color(legend_edge, legend_alpha)

  x_tick_length <- if (x_tick_style$direction == "in") -x_tick_style$length else x_tick_style$length
  y_tick_length <- if (y_tick_style$direction == "in") -y_tick_style$length else y_tick_style$length
  grid_color_effective <- alpha_color(grid_color, grid_alpha)
  grid_line <- ggplot2::element_line(colour = grid_color_effective, linewidth = grid_width, linetype = grid_style_str)
  grid_minor_line <- ggplot2::element_line(colour = grid_color_effective, linewidth = grid_width * 0.5, linetype = grid_style_str)

  plot_obj <- plot_obj +
    ggplot2::labs(title = title_text, x = x_text, y = y_text)

  if (nzchar(legend_title)) {
    if (has_edit("legend_title.0", "text") || has_edit("legend.0", "title")) {
      for (scale_index in seq_along(plot_obj$scales$scales)) {
        kind <- scale_kind(plot_obj$scales$scales[[scale_index]])
        if (!is.null(kind) && kind %in% c("color", "fill")) {
          plot_obj$scales$scales[[scale_index]]$name <- legend_title
        }
      }
    }
    plot_obj <- plot_obj + ggplot2::labs(color = legend_title, colour = legend_title, fill = legend_title)
  }

  plot_obj <- plot_obj +
    ggplot2::theme(
      plot.title = ggplot2::element_text(
        size = title_style$fontsize,
        family = title_style$fontfamily,
        colour = title_style$color,
        face = title_style$face
      ),
      axis.title.x = ggplot2::element_text(
        size = x_label_style$fontsize,
        family = x_label_style$fontfamily,
        colour = x_label_style$color,
        face = x_label_style$face
      ),
      axis.title.y = ggplot2::element_text(
        size = y_label_style$fontsize,
        family = y_label_style$fontfamily,
        colour = y_label_style$color,
        face = y_label_style$face
      ),
      axis.text.x = ggplot2::element_text(
        size = x_tick_style$fontsize,
        family = x_tick_style$fontfamily,
        colour = x_tick_style$color,
        face = x_tick_style$face,
        angle = x_tick_style$rotation,
        margin = ggplot2::margin(t = x_tick_style$pad)
      ),
      axis.text.y = ggplot2::element_text(
        size = y_tick_style$fontsize,
        family = y_tick_style$fontfamily,
        colour = y_tick_style$color,
        face = y_tick_style$face,
        angle = y_tick_style$rotation,
        margin = ggplot2::margin(r = y_tick_style$pad)
      ),
      axis.ticks.x = ggplot2::element_line(
        colour = x_tick_style$tick_color,
        linewidth = x_tick_style$width
      ),
      axis.ticks.y = ggplot2::element_line(
        colour = y_tick_style$tick_color,
        linewidth = y_tick_style$width
      ),
      axis.ticks.length.x = ggplot2::unit(x_tick_length, "pt"),
      axis.ticks.length.y = ggplot2::unit(y_tick_length, "pt"),
      legend.text = ggplot2::element_text(
        size = legend_item_style$fontsize,
        family = legend_item_style$fontfamily,
        colour = legend_item_style$color,
        face = legend_item_style$face,
        margin = ggplot2::margin(
          t = legend_row_pad_pt,
          r = legend_column_pad_pt,
          b = legend_row_pad_pt,
          l = legend_text_pad_pt,
          unit = "pt"
        )
      ),
      legend.title = ggplot2::element_text(
        size = legend_title_style$fontsize,
        family = legend_title_style$fontfamily,
        colour = legend_title_style$color,
        face = legend_title_style$face
      ),
      legend.position = if (!legend_visible_bool) "none" else r_legend_pos,
      legend.background = if (legend_edge == "none" && legend_face == "white" && legend_alpha == 1.0) {
        ggplot2::element_rect(fill = "white", colour = "transparent")
      } else {
        ggplot2::element_rect(
          fill = legend_face_effective,
          colour = legend_edge_effective,
          linewidth = legend_lw
        )
      },
      legend.key.size = ggplot2::unit(legend_markerscale, "lines"),
      legend.key.width = ggplot2::unit(max(1, legend_markerscale), "lines"),
      legend.key.height = ggplot2::unit(max(1, legend_markerscale), "lines"),
      legend.margin = ggplot2::margin(
        t = legend_borderpad_pt,
        r = legend_borderpad_pt,
        b = legend_borderpad_pt,
        l = legend_borderpad_pt,
        unit = "pt"
      ),
      strip.text = ggplot2::element_text(
        size = strip_style$fontsize,
        family = strip_style$fontfamily,
        colour = strip_style$color,
        face = strip_style$face
      ),
      panel.grid.major = if (!grid_visible) {
        ggplot2::element_blank()
      } else if (has_edit("grid.0", "color") || has_edit("grid.0", "linewidth") || has_edit("grid.0", "linestyle") || has_edit("grid.0", "alpha")) {
        grid_line
      } else {
        NULL
      },
      panel.grid.major.x = if (!grid_visible) {
        ggplot2::element_blank()
      } else if (has_edit("grid.0", "color") || has_edit("grid.0", "linewidth") || has_edit("grid.0", "linestyle") || has_edit("grid.0", "alpha")) {
        grid_line
      } else {
        NULL
      },
      panel.grid.major.y = if (!grid_visible) {
        ggplot2::element_blank()
      } else if (has_edit("grid.0", "color") || has_edit("grid.0", "linewidth") || has_edit("grid.0", "linestyle") || has_edit("grid.0", "alpha")) {
        grid_line
      } else {
        NULL
      },
      panel.grid.minor = if (!grid_visible) {
        ggplot2::element_blank()
      } else if (has_edit("grid.0", "color") || has_edit("grid.0", "linewidth") || has_edit("grid.0", "linestyle") || has_edit("grid.0", "alpha")) {
        grid_minor_line
      } else {
        NULL
      },
      panel.grid.minor.x = if (!grid_visible) {
        ggplot2::element_blank()
      } else if (has_edit("grid.0", "color") || has_edit("grid.0", "linewidth") || has_edit("grid.0", "linestyle") || has_edit("grid.0", "alpha")) {
        grid_minor_line
      } else {
        NULL
      },
      panel.grid.minor.y = if (!grid_visible) {
        ggplot2::element_blank()
      } else if (has_edit("grid.0", "color") || has_edit("grid.0", "linewidth") || has_edit("grid.0", "linestyle") || has_edit("grid.0", "alpha")) {
        grid_minor_line
      } else {
        NULL
      },
      axis.line.x = if (isTRUE(x_spine_visible)) {
        ggplot2::element_line(colour = x_spine_color, linewidth = x_spine_width)
      } else {
        ggplot2::element_blank()
      },
      axis.line.y = if (isTRUE(y_spine_visible)) {
        ggplot2::element_line(colour = y_spine_color, linewidth = y_spine_width)
      } else {
        ggplot2::element_blank()
      },
      panel.border = if (border_visible) {
        ggplot2::element_rect(colour = border_color, linewidth = border_width, fill = NA)
      } else {
        ggplot2::element_blank()
      }
    )

  subplot_aspect <- subplot_aspect_value()
  if (!identical(subplot_aspect, "auto")) {
    plot_obj <- plot_obj + ggplot2::theme(aspect.ratio = subplot_aspect)
  }

  legend_guide_props <- c("ncol", "markerscale", "handletextpad", "labelspacing", "columnspacing", "borderpad")
  if (any(vapply(legend_guide_props, function(prop) has_edit("legend.0", prop), logical(1)))) {
    continuous_kinds <- unique(vapply(find_continuous_colour_scales(plot_obj), function(item) item$kind, character(1)))
    guide <- ggplot2::guide_legend(
      ncol = legend_ncol,
      keywidth = ggplot2::unit(max(1, legend_markerscale), "lines"),
      keyheight = ggplot2::unit(max(1, legend_markerscale), "lines"),
      override.aes = list(size = 3 * legend_markerscale)
    )
    guide_args <- list()
    if (!"color" %in% continuous_kinds) {
      guide_args$color <- guide
      guide_args$colour <- guide
    }
    if (!"fill" %in% continuous_kinds) {
      guide_args$fill <- guide
    }
    if (length(guide_args) > 0) {
      plot_obj <- plot_obj + do.call(ggplot2::guides, guide_args)
    }
  }

  if (has_edit("axis.x.0", "limits")) {
    lims <- latest_value("axis.x.0", "limits", NULL)
    if (is.numeric(lims) && length(lims) >= 2 && all(is.finite(lims))) {
      plot_obj <- plot_obj + ggplot2::xlim(lims[[1]], lims[[2]])
    }
  }
  if (has_edit("axis.y.0", "limits")) {
    lims <- latest_value("axis.y.0", "limits", NULL)
    if (is.numeric(lims) && length(lims) >= 2 && all(is.finite(lims))) {
      plot_obj <- plot_obj + ggplot2::ylim(lims[[1]], lims[[2]])
    }
  }

  if (isTRUE(grid_visible) && (has_edit("grid.0", "color") || has_edit("grid.0", "linewidth") || has_edit("grid.0", "linestyle") || has_edit("grid.0", "alpha"))) {
    x_breaks <- axis_breaks_from_build(plot_obj, "x", 1)
    y_breaks <- axis_breaks_from_build(plot_obj, "y", 1)
    if (length(x_breaks) > 0) {
      plot_obj <- plot_obj + ggplot2::geom_vline(
        xintercept = x_breaks,
        colour = grid_color_effective,
        linewidth = grid_width,
        linetype = grid_style_str,
        inherit.aes = FALSE,
        show.legend = FALSE
      )
    }
    if (length(y_breaks) > 0) {
      plot_obj <- plot_obj + ggplot2::geom_hline(
        yintercept = y_breaks,
        colour = grid_color_effective,
        linewidth = grid_width,
        linetype = grid_style_str,
        inherit.aes = FALSE,
        show.legend = FALSE
      )
    }
  }

  plot_obj <- apply_discrete_scale_edits(plot_obj)
  plot_obj <- apply_legend_text_edits(plot_obj)
  plot_obj <- apply_continuous_scale_edits(plot_obj)
  plot_obj <- apply_text_layer_edits(plot_obj)
  apply_layer_edits(plot_obj)
}

`%||%` <- function(lhs, rhs) {
  if (is.null(lhs) || length(lhs) == 0) rhs else lhs
}

manifest_text_object <- function(id, label, text, style) {
  list(
    id = id,
    kind = "text",
    label = label,
    editable = list("text", "fontsize", "fontfamily", "fontweight", "fontstyle", "color"),
    currentProps = list(
      text = text,
      fontsize = style$fontsize,
      fontfamily = style$fontfamily,
      fontweight = style$fontweight,
      fontstyle = style$fontstyle,
      color = style$color
    ),
    role = label,
    source = list(artistClass = "ggplot_label", axesIndex = 0)
  )
}

legend_item_semantics <- function(plot_obj) {
  catalog <- discrete_scale_catalog(plot_obj)
  items <- list()
  for (entry in catalog$entries) {
    for (i in seq_along(entry$keys)) {
      key <- as.character(entry$keys[[i]])
      label <- as.character(entry$labels[[i]])
      merge_key <- paste(entry$guideKey, key, label, sep = ":")
      existing_index <- which(vapply(items, function(item) identical(item$mergeKey, merge_key), logical(1)))
      if (length(existing_index) > 0) {
        item_index <- existing_index[[1]]
        items[[item_index]]$aesthetics <- sort(unique(c(items[[item_index]]$aesthetics, entry$kind)))
        items[[item_index]]$scaleKeys <- sort(unique(c(items[[item_index]]$scaleKeys, entry$scaleKey)))
        next
      }
      items[[length(items) + 1]] <- list(
        mergeKey = merge_key,
        guideKey = entry$guideKey,
        aesthetics = entry$kind,
        scaleKeys = entry$scaleKey,
        key = key,
        label = label
      )
    }
  }
  items
}

legend_item_labels <- function(plot_obj) {
  items <- legend_item_semantics(plot_obj)
  if (length(items) == 0) return(character())
  vapply(items, function(item) item$label, character(1))
}

manifest_legend_text_objects <- function(plot_obj, legend_title, legend_style, legend_guide_key = "ggplot-guide:discrete") {
  objects <- list()
  title_style <- style_for_gid("legend_title.0", legend_style)
  if (nzchar(legend_title)) {
    objects[[length(objects) + 1]] <- manifest_text_object("legend_title.0", "legend_title", legend_title, title_style)
    objects[[length(objects)]]$role <- "legend_title"
    objects[[length(objects)]]$guideKey <- legend_guide_key
    objects[[length(objects)]]$source <- list(artistClass = "ggplot_legend_title", axesIndex = 0)
  }

  items <- legend_item_semantics(plot_obj)
  if (length(items) == 0) return(objects)
  for (i in seq_along(items)) {
    label <- items[[i]]$label
    gid <- paste0("legend_text.0.", i - 1)
    text_weight <- latest_string(gid, "fontweight", legend_style$fontweight)
    text_style <- latest_string(gid, "fontstyle", legend_style$fontstyle)
    style <- list(
      fontsize = latest_numeric(gid, "fontsize", legend_style$fontsize),
      fontfamily = latest_string(gid, "fontfamily", legend_style$fontfamily),
      color = latest_string(gid, "color", legend_style$color),
      fontweight = text_weight,
      fontstyle = text_style,
      face = font_face(text_weight, text_style)
    )
    obj <- manifest_text_object(gid, "legend_text", latest_string(gid, "text", label), style)
    obj$currentProps$originalText <- label
    obj$editable <- list("text", "fontsize", "fontfamily", "fontweight", "fontstyle", "color")
    obj$role <- "legend_text"
    obj$dataKey <- if (length(items[[i]]$aesthetics) == 1) {
      paste("legend", items[[i]]$aesthetics[[1]], items[[i]]$key, sep = ":")
    } else {
      paste("legend", items[[i]]$guideKey, items[[i]]$key, sep = ":")
    }
    obj$aesthetic <- paste(items[[i]]$aesthetics, collapse = "+")
    obj$scaleKey <- paste(items[[i]]$scaleKeys, collapse = "|")
    obj$guideKey <- items[[i]]$guideKey
    obj$source <- list(artistClass = "ggplot_legend_text", axesIndex = 0, zorder = i)
    objects[[length(objects) + 1]] <- obj
  }
  objects
}

manifest_axis_object <- function(id, label, style, plot_obj = NULL) {
  axis_name <- if (grepl("^axis\\.x", id)) "x" else "y"
  label_gid <- if (axis_name == "x") "xlabel.0" else "ylabel.0"
  label_fallback <- if (axis_name == "x") plot_obj$labels$x %||% "" else plot_obj$labels$y %||% ""
  label_text <- axis_label_text_for_gid(id, label_gid, label_fallback)
  label_style <- axis_label_style_for_gid(id, label_gid, default_label)
  lims <- if (has_edit(id, "limits")) latest_value(id, "limits", NULL) else axis_limits_from_build(plot_obj, axis_name, 1)
  list(
    id = id,
    kind = if (axis_name == "x") "axis_x" else "axis_y",
    label = label,
    editable = list("label", "label_fontsize", "label_color", "tick_labelsize", "tick_labelfamily", "tick_labelcolor", "tick_fontweight", "tick_fontstyle", "limits", "tick_rotation", "tick_direction", "tick_length", "tick_width", "tick_color", "tick_pad"),
    currentProps = list(
      label = label_text,
      label_fontsize = label_style$fontsize,
      label_color = label_style$color,
      tick_labelsize = style$fontsize,
      tick_labelfamily = style$fontfamily,
      tick_labelcolor = style$color,
      tick_fontweight = style$fontweight,
      tick_fontstyle = style$fontstyle,
      limits = lims,
      tick_rotation = style$rotation,
      tick_direction = style$direction,
      tick_length = style$length,
      tick_width = style$width,
      tick_color = style$tick_color,
      tick_pad = style$pad
    ),
    role = label,
    source = list(artistClass = "ggplot_axis", axesIndex = 0)
  )
}

r_expression_label <- function(value) {
  if (is.null(value)) return("")
  if (requireNamespace("rlang", quietly = TRUE)) {
    labelled <- tryCatch(rlang::as_label(value), error = function(e) NULL)
    if (!is.null(labelled) && nzchar(labelled)) return(as.character(labelled))
  }
  paste(deparse(value, width.cutoff = 500L), collapse = "")
}

r_mapping_signature <- function(mapping) {
  if (is.null(mapping) || length(mapping) == 0) return("inherit")
  mapping_names <- sort(names(mapping))
  paste(vapply(mapping_names, function(name) {
    paste0(name, "=", r_expression_label(mapping[[name]]))
  }, character(1)), collapse = "|")
}

r_effective_layer_mapping <- function(layer, plot_mapping = NULL) {
  layer_mapping <- layer$mapping %||% list()
  if (!isTRUE(layer$inherit.aes)) return(layer_mapping)
  effective <- plot_mapping %||% list()
  if (length(layer_mapping) > 0) {
    for (name in names(layer_mapping)) effective[[name]] <- layer_mapping[[name]]
  }
  effective
}

r_layer_data_scope_signature <- function(layer) {
  cached <- layer$.scifigure_data_scope_signature %||% NULL
  if (!is.null(cached) && nzchar(as.character(cached))) return(as.character(cached))
  layer_data <- layer$data
  if (is.null(layer_data) || inherits(layer_data, "waiver")) return("plot-data")
  data_frame <- tryCatch(as.data.frame(layer_data), error = function(e) NULL)
  if (is.null(data_frame)) return(paste("layer-data", class(layer_data)[[1]] %||% "unknown", sep = ":"))
  column_names <- sort(names(data_frame))
  canonical_frame <- data_frame[, column_names, drop = FALSE]
  structure <- list(
    rows = nrow(canonical_frame),
    columns = lapply(column_names, function(name) list(
      name = name,
      type = typeof(canonical_frame[[name]]),
      class = as.list(class(canonical_frame[[name]])),
      levels = if (is.factor(canonical_frame[[name]])) as.list(levels(canonical_frame[[name]])) else NULL,
      values = as.list(canonical_frame[[name]])
    ))
  )
  canonical <- jsonlite::toJSON(structure, auto_unbox = TRUE, null = "null", na = "string", digits = NA)
  digest_path <- tempfile("scifigure-r-layer-scope-", fileext = ".json")
  on.exit(try(unlink(digest_path), silent = TRUE), add = TRUE)
  writeBin(charToRaw(enc2utf8(canonical)), digest_path)
  digest <- unname(as.character(tools::md5sum(digest_path)[[1]]))
  signature <- paste("layer-data", nrow(canonical_frame), paste(column_names, collapse = ","), digest, sep = ":")
  layer$.scifigure_data_scope_signature <- signature
  signature
}

r_layer_structure_signature <- function(layer, plot_mapping = NULL) {
  frozen_identity_key <- layer$.scifigure_identity_key %||% NULL
  if (!is.null(frozen_identity_key) && nzchar(as.character(frozen_identity_key))) {
    return(as.character(frozen_identity_key))
  }
  paste(
    geom_class(layer),
    class(layer$stat)[[1]] %||% "StatIdentity",
    class(layer$position)[[1]] %||% "PositionIdentity",
    if (isTRUE(layer$inherit.aes)) "inherit" else "isolated",
    r_mapping_signature(r_effective_layer_mapping(layer, plot_mapping)),
    r_layer_data_scope_signature(layer),
    sep = ":"
  )
}

manifest_layer_object <- function(layer, index, plot_mapping = NULL) {
  geom <- geom_class(layer)
  gid <- paste0("r.layer.", index - 1)
  layer_key <- r_layer_structure_signature(layer, plot_mapping)
  kind <- layer_kind(geom)
  props <- layer_current_props(layer, gid)
  editable <- switch(
    kind,
    text = list("color", "fontsize", "alpha"),
    collection = list("color", "facecolor", "size", "alpha"),
    line = list("color", "linewidth", "linestyle", "alpha"),
    patch = list("facecolor", "edgecolor", "linewidth", "alpha"),
    errorbar_container = list("color", "linewidth", "alpha"),
    boxplot_container = list("color", "linewidth", "alpha", "box_color", "median_color"),
    violinplot_container = list("color", "facecolor", "edgecolor", "linewidth", "alpha"),
    unsupported = list(),
    list()
  )
  current_props <- switch(
    kind,
    text = list(color = props$color, fontsize = props$size, alpha = props$alpha),
    collection = list(color = props$color, facecolor = props$facecolor, size = props$size, alpha = props$alpha),
    line = list(color = props$color, linewidth = props$linewidth, linestyle = props$linestyle, alpha = props$alpha),
    patch = list(facecolor = props$facecolor, edgecolor = props$edgecolor, linewidth = props$linewidth, alpha = props$alpha),
    errorbar_container = list(color = props$color, linewidth = props$linewidth, alpha = props$alpha),
    boxplot_container = list(color = props$color, linewidth = props$linewidth, alpha = props$alpha, box_color = latest_string(gid, "box_color", props$facecolor), median_color = latest_string(gid, "median_color", props$edgecolor)),
    violinplot_container = list(color = props$color, facecolor = props$facecolor, edgecolor = props$edgecolor, linewidth = props$linewidth, alpha = props$alpha),
    unsupported = list(unsupportedReason = paste0("No stable SciFigure write-back adapter for ggplot geom class ", geom, ".")),
    list()
  )
  list(
    id = gid,
    kind = kind,
    label = layer_label(geom, index),
    editable = editable,
    currentProps = current_props,
    role = paste0("ggplot_", geom),
    layerKey = layer_key,
    source = list(
      artistClass = geom,
      axesIndex = 0,
      zorder = index,
      layerSignature = layer_key
    )
  )
}

is_faceted_plot <- function(plot_obj) {
  inherits(plot_obj, "ggplot") && !inherits(plot_obj$facet, "FacetNull")
}

facet_label_from_row <- function(row) {
  skip <- c("PANEL", "ROW", "COL", "SCALE_X", "SCALE_Y", "COORD")
  cols <- setdiff(names(row), skip)
  if (length(cols) == 0) return("")
  parts <- vapply(cols, function(col) {
    value <- row[[col]]
    if (is.null(value) || length(value) == 0 || is.na(value[[1]])) return("")
    paste0(col, "=", as.character(value[[1]]))
  }, character(1))
  parts <- parts[nzchar(parts)]
  paste(parts, collapse = ", ")
}

facet_key_from_row <- function(row) {
  label <- facet_label_from_row(row)
  if (nzchar(label)) return(label)
  row_value <- row$ROW %||% 1L
  col_value <- row$COL %||% 1L
  row_index <- suppressWarnings(as.integer(row_value[[1]]))
  col_index <- suppressWarnings(as.integer(col_value[[1]]))
  paste0("row=", row_index, ",col=", col_index)
}

facet_panel_key_map <- function(plot_obj) {
  if (!is_faceted_plot(plot_obj)) return(c("1" = "root"))
  built <- tryCatch(ggplot2::ggplot_build(plot_obj), error = function(e) NULL)
  layout <- built$layout$layout %||% NULL
  if (is.null(layout) || nrow(layout) == 0) return(character())
  keys <- vapply(
    seq_len(nrow(layout)),
    function(i) facet_key_from_row(layout[i, , drop = FALSE]),
    character(1)
  )
  names(keys) <- as.character(layout$PANEL)
  keys
}

manifest_single_subplot_object <- function(plot_obj, layout_bounds = list()) {
  if (is_faceted_plot(plot_obj)) return(NULL)
  bounds <- layout_bounds$panel %||% list(left = 0.10, bottom = 0.12, width = 0.72, height = 0.76)
  list(
    id = "subplot.0",
    kind = "subplot",
    label = "Plot panel",
    editable = list("aspect"),
    currentProps = list(
      subplotIndex = 0,
      panel = 1,
      row = 1,
      col = 1,
      label = "",
      left = bounds$left,
      bottom = bounds$bottom,
      width = bounds$width,
      height = bounds$height,
      aspect = subplot_aspect_value(),
      unsupportedProps = list("left", "bottom", "width", "height"),
      unsupportedReason = "ggplot panel bounds are measured from the rendered SVG and are reference-only; independent panel geometry remains controlled by the ggplot gtable."
    ),
    role = "ggplot_panel",
    facetKey = "root",
    source = list(artistClass = "ggplot_panel", axesIndex = 0)
  )
}

manifest_facet_objects <- function(plot_obj) {
  if (!is_faceted_plot(plot_obj)) return(list())
  built <- tryCatch(ggplot2::ggplot_build(plot_obj), error = function(e) NULL)
  if (is.null(built) || is.null(built$layout) || is.null(built$layout$layout)) return(list())
  layout <- built$layout$layout
  if (nrow(layout) == 0) return(list())
  aspect <- subplot_aspect_value()

  lapply(seq_len(nrow(layout)), function(i) {
    row <- layout[i, , drop = FALSE]
    panel <- as.integer(row$PANEL[[1]])
    row_index <- as.integer(row$ROW[[1]])
    col_index <- as.integer(row$COL[[1]])
    label <- facet_label_from_row(row)
    facet_key <- facet_key_from_row(row)
    list(
      id = paste0("subplot.", panel - 1),
      kind = "subplot",
      label = if (nzchar(label)) paste0("Facet ", panel, ": ", label) else paste0("Facet ", panel),
      editable = list("aspect"),
      currentProps = list(
        subplotIndex = panel - 1,
        panel = panel,
        row = row_index,
        col = col_index,
        label = label,
        aspect = aspect,
        unsupportedProps = list("left", "bottom", "width", "height"),
        unsupportedReason = "ggplot facet panels use shared gtable layout; independent panel bounds are not equivalent to Matplotlib axes bounds."
      ),
      role = "ggplot_facet_panel",
      facetKey = facet_key,
      source = list(artistClass = "ggplot_facet_panel", axesIndex = panel - 1)
    )
  })
}

manifest_facet_strip_object <- function(plot_obj) {
  if (!is_faceted_plot(plot_obj)) return(NULL)
  strip_style <- style_for_gid("facet.strip.0", default_strip)
  list(
    id = "facet.strip.0",
    kind = "text",
    label = "facet_strip_titles",
    editable = list("fontsize", "fontfamily", "fontweight", "fontstyle", "color"),
    currentProps = list(
      text = "Facet strip titles",
      fontsize = strip_style$fontsize,
      fontfamily = strip_style$fontfamily,
      fontweight = strip_style$fontweight,
      fontstyle = strip_style$fontstyle,
      color = strip_style$color
    ),
    role = "facet_strip_title",
    source = list(artistClass = "ggplot_facet_strip", axesIndex = 0)
  )
}

manifest_text_layer_objects <- function(plot_obj) {
  rows <- text_layer_rows(plot_obj)
  if (length(rows) == 0) return(list())
  ranges <- panel_ranges(plot_obj)
  position_context <- text_position_context(plot_obj)
  position_support <- text_position_support(plot_obj, position_context)
  panel_keys <- facet_panel_key_map(plot_obj)

  lapply(rows, function(item) {
    data <- item$data
    gid <- text_row_edit_gid(item)
    manifest_gid <- text_row_gid(item)
    layer_key <- r_layer_structure_signature(plot_obj$layers[[item$layerIndex]], plot_obj$mapping)
    panel <- as.integer(data$PANEL %||% 1)
    range <- ranges[[as.character(panel)]]
    frac <- coord_to_axes_fraction(position_context, panel, data$x, data$y)
    if (is.null(frac)) frac <- to_axes_fraction(data$x, data$y, range)
    pos <- latest_axes_position(gid, frac$x, frac$y)
    if (has_edit(gid, "position")) {
      requested <- extract_position_value(latest_value(gid, "position", NULL))
      if (!is.null(requested) && identical(requested$coord_system, "axes")) {
        validated <- coord_from_axes_fraction(position_context, panel, requested$x, requested$y, data$x, data$y)
        if (is.null(validated)) pos <- frac
      }
    }
    face <- text_fontface_to_weight_style(data$fontface %||% 1)
    raw_position <- inverse_text_position_scales(data.frame(x = data$x, y = data$y), position_context)
    editable <- list("text", "fontsize", "fontfamily", "fontweight", "fontstyle", "color")
    current_props <- list(
      text = latest_string(gid, "text", as.character(data$label %||% "")),
      fontsize = latest_numeric(gid, "fontsize", as.numeric(data$size %||% default_label$fontsize)),
      fontfamily = latest_string(gid, "fontfamily", as.character(data$family %||% "")),
      fontweight = latest_string(gid, "fontweight", face$fontweight),
      fontstyle = latest_string(gid, "fontstyle", face$fontstyle),
      color = latest_string(gid, "color", as.character(data$colour %||% "black")),
      data_x = as.numeric(raw_position$x),
      data_y = as.numeric(raw_position$y),
      dataKey = item$dataKey,
      identityStability = if (!is.null(item$dataKey)) "stable" else "unsupported",
      identityStabilityReason = if (!is.null(item$dataKey)) {
        if (identical(item$dataKeySource, "source")) {
          "Stable data key supplied by the text layer source data."
        } else {
          "Stable semantic key derived from the original text label, coordinates, and panel."
        }
      } else {
        "No unique source or semantic row key is available; replay is disabled to prevent ordinal remapping."
      }
    )
    if (isTRUE(position_support$supported)) {
      editable <- c(editable, list("position"))
      current_props$x <- pos$x
      current_props$y <- pos$y
      current_props$coord_system <- "axes"
    } else {
      current_props$positionEditable <- FALSE
      current_props$positionUnsupportedReason <- position_support$reason
    }
    list(
      id = manifest_gid,
      kind = "text",
      label = paste0("ggplot text ", item$layerIndex - 1, ".", item$rowIndex - 1),
      editable = editable,
      currentProps = current_props,
      role = "ggplot_text_annotation",
      annotationId = manifest_gid,
      subplotId = paste0("subplot.", panel - 1),
      facetKey = panel_keys[[as.character(panel)]] %||% "root",
      layerId = paste0("r.layer.", item$layerIndex - 1),
      layerKey = layer_key,
      groupKey = as.character(data$group %||% item$rowIndex),
      dataKey = item$dataKey,
      aesthetic = "label",
      source = list(artistClass = item$geom, axesIndex = panel - 1, zorder = item$layerIndex)
    )
  })
}

svg_tag_number <- function(tag, name) {
  pattern <- paste0("\\b", name, "\\s*=\\s*['\"]([^'\"]+)['\"]")
  matched <- regexec(pattern, tag, perl = TRUE)
  values <- regmatches(tag, matched)[[1]]
  if (length(values) < 2) return(NA_real_)
  suppressWarnings(as.numeric(values[[2]]))
}

svg_tags <- function(svg, pattern) {
  matches <- gregexpr(pattern, svg, perl = TRUE)[[1]]
  if (length(matches) == 1 && matches[[1]] == -1) return(character())
  regmatches(svg, list(matches))[[1]]
}

normalized_svg_rect <- function(rect, total_width, total_height) {
  if (is.null(rect) || !all(is.finite(unlist(rect)))) return(NULL)
  list(
    left = rect$x / total_width,
    bottom = 1 - ((rect$y + rect$height) / total_height),
    width = rect$width / total_width,
    height = rect$height / total_height
  )
}

svg_plot_layout_bounds <- function(svg) {
  if (is.null(svg) || !nzchar(svg)) return(list(panel = NULL, colorbar = NULL))
  viewbox_match <- regexec(
    "viewBox\\s*=\\s*['\"]\\s*[-+0-9.eE]+\\s+[-+0-9.eE]+\\s+([-+0-9.eE]+)\\s+([-+0-9.eE]+)\\s*['\"]",
    svg,
    perl = TRUE
  )
  viewbox <- regmatches(svg, viewbox_match)[[1]]
  if (length(viewbox) < 3) return(list(panel = NULL, colorbar = NULL))
  total_width <- suppressWarnings(as.numeric(viewbox[[2]]))
  total_height <- suppressWarnings(as.numeric(viewbox[[3]]))
  if (!is.finite(total_width) || !is.finite(total_height) || total_width <= 0 || total_height <= 0) {
    return(list(panel = NULL, colorbar = NULL))
  }

  panel_candidates <- list()
  for (block in svg_tags(svg, "<clipPath\\b[\\s\\S]*?</clipPath>")) {
    rect_tags <- svg_tags(block, "<rect\\b[^>]*>")
    if (length(rect_tags) == 0) next
    tag <- rect_tags[[1]]
    rect <- list(
      x = svg_tag_number(tag, "x"),
      y = svg_tag_number(tag, "y"),
      width = svg_tag_number(tag, "width"),
      height = svg_tag_number(tag, "height")
    )
    values <- unlist(rect)
    if (!all(is.finite(values)) || rect$width <= 0 || rect$height <= 0) next
    if (rect$x <= 0.5 || rect$y <= 0.5) next
    if (rect$width >= total_width * 0.98 || rect$height >= total_height * 0.98) next
    panel_candidates[[length(panel_candidates) + 1]] <- rect
  }
  panel_rect <- NULL
  if (length(panel_candidates) > 0) {
    areas <- vapply(panel_candidates, function(rect) rect$width * rect$height, numeric(1))
    panel_rect <- panel_candidates[[which.max(areas)]]
  }

  colorbar_candidates <- list()
  for (tag in svg_tags(svg, "<image\\b[^>]*>")) {
    rect <- list(
      x = svg_tag_number(tag, "x"),
      y = svg_tag_number(tag, "y"),
      width = svg_tag_number(tag, "width"),
      height = svg_tag_number(tag, "height")
    )
    values <- unlist(rect)
    if (!all(is.finite(values)) || rect$width <= 0 || rect$height <= 0) next
    long_side <- max(rect$width, rect$height)
    short_side <- min(rect$width, rect$height)
    if (long_side <= 0 || short_side / long_side > 0.40) next
    if (!is.null(panel_rect)) {
      center_x <- rect$x + rect$width / 2
      center_y <- rect$y + rect$height / 2
      inside_panel <- center_x >= panel_rect$x && center_x <= panel_rect$x + panel_rect$width &&
        center_y >= panel_rect$y && center_y <= panel_rect$y + panel_rect$height
      if (inside_panel) next
    }
    colorbar_candidates[[length(colorbar_candidates) + 1]] <- rect
  }
  colorbar_rect <- NULL
  if (length(colorbar_candidates) > 0) {
    areas <- vapply(colorbar_candidates, function(rect) rect$width * rect$height, numeric(1))
    colorbar_rect <- colorbar_candidates[[which.max(areas)]]
  }

  list(
    panel = normalized_svg_rect(panel_rect, total_width, total_height),
    colorbar = normalized_svg_rect(colorbar_rect, total_width, total_height)
  )
}

continuous_scale_layer_usage <- function(plot_obj, built, kind) {
  aliases <- if (identical(kind, "fill")) c("fill") else c("colour", "color")
  layer_ids <- character()
  subplot_ids <- character()
  heatmap_layer_ids <- character()

  for (layer_index in seq_along(plot_obj$layers)) {
    layer <- plot_obj$layers[[layer_index]]
    mapped <- names(layer$mapping %||% list())
    if (isTRUE(layer$inherit.aes)) mapped <- union(names(plot_obj$mapping %||% list()), mapped)
    if (!any(mapped %in% aliases)) next
    layer_id <- paste0("r.layer.", layer_index - 1)
    layer_ids <- c(layer_ids, layer_id)
    geom <- geom_class(layer)
    if (geom %in% c("GeomTile", "GeomRaster", "GeomRect")) {
      heatmap_layer_ids <- c(heatmap_layer_ids, layer_id)
    }
    if (!is.null(built) && !is.null(built$data) && length(built$data) >= layer_index) {
      data <- built$data[[layer_index]]
      if (!is.null(data) && nrow(data) > 0 && "PANEL" %in% names(data)) {
        panels <- unique(as.integer(data$PANEL))
        panels <- panels[is.finite(panels)]
        subplot_ids <- c(subplot_ids, paste0("subplot.", panels - 1))
      }
    }
  }

  list(
    layerIds = as.list(unique(layer_ids)),
    heatmapLayerIds = as.list(unique(heatmap_layer_ids)),
    subplotIds = as.list(unique(subplot_ids))
  )
}

manifest_continuous_colorbar_objects <- function(plot_obj, layout_bounds = list()) {
  continuous_scales <- find_continuous_colour_scales(plot_obj)
  if (length(continuous_scales) == 0) return(list())
  built <- tryCatch(ggplot2::ggplot_build(plot_obj), error = function(e) NULL)

  objects <- list()
  for (item in continuous_scales) {
    scale_obj <- item$scale
    kind <- item$kind
    scale_index <- item$index
    limits <- continuous_limits(scale_obj)
    current_vmin <- if (is.finite(limits[[1]])) limits[[1]] else NULL
    current_vmax <- if (is.finite(limits[[2]])) limits[[2]] else NULL
    label <- as.character(scale_obj$name %||% plot_obj$labels[[kind]] %||% kind)
    heatmap_gid <- paste0("r.heatmap.", kind, ".", scale_index)
    colorbar_gid <- paste0("r.colorbar.", kind, ".", scale_index)
    scale_id <- paste0("r.scale.", kind, ".continuous.", scale_index)
    mapping_key <- r_aesthetic_mapping_signature(plot_obj, kind)
    scale_key <- r_scale_structure_key(scale_obj, kind, character(), mapping_key)
    guide_key <- paste("ggplot-colorbar", scale_key, sep = ":")
    usage <- continuous_scale_layer_usage(plot_obj, built, kind)
    if (length(usage$layerIds) == 0) next
    subplot_ids <- usage$subplotIds
    if (length(subplot_ids) == 0 && !is_faceted_plot(plot_obj)) subplot_ids <- list("subplot.0")
    has_heatmap <- length(usage$heatmapLayerIds) > 0

    if (has_heatmap) {
      objects[[length(objects) + 1]] <- list(
        id = heatmap_gid,
        kind = "heatmap",
        label = paste0("ggplot heatmap ", kind, " scale"),
        editable = list("cmap", "vmin", "vmax", "alpha"),
        currentProps = list(
          cmap = latest_string(heatmap_gid, "cmap", "custom"),
          vmin = latest_numeric(heatmap_gid, "vmin", current_vmin),
          vmax = latest_numeric(heatmap_gid, "vmax", current_vmax),
          alpha = latest_numeric(heatmap_gid, "alpha", 1),
          scale = kind
        ),
        role = "ggplot_heatmap_series",
        colorbarId = colorbar_gid,
        layerIds = usage$heatmapLayerIds,
        subplotIds = subplot_ids,
        scaleId = scale_id,
        guideId = colorbar_gid,
        scaleKey = scale_key,
        guideKey = guide_key,
        aesthetic = kind,
        source = list(artistClass = "ggplot_heatmap_scale", axesIndex = 0, zorder = scale_index)
      )
    }

    colorbar_bounds <- layout_bounds$colorbar %||% default_colorbar
    mappable_ids <- if (has_heatmap) list(heatmap_gid) else usage$layerIds
    mappable_id <- mappable_ids[[1]]

    objects[[length(objects) + 1]] <- list(
      id = colorbar_gid,
      kind = "colorbar",
      label = paste0("ggplot colorbar ", label),
      editable = list("label", "tick_fontsize", "visible", "left", "bottom", "width", "height"),
      currentProps = list(
        label = latest_string(colorbar_gid, "label", label),
        tick_fontsize = latest_numeric(colorbar_gid, "tick_fontsize", default_legend$fontsize),
        visible = latest_value(colorbar_gid, "visible", TRUE),
        left = latest_numeric(colorbar_gid, "left", colorbar_bounds$left),
        bottom = latest_numeric(colorbar_gid, "bottom", colorbar_bounds$bottom),
        width = latest_numeric(colorbar_gid, "width", colorbar_bounds$width),
        height = latest_numeric(colorbar_gid, "height", colorbar_bounds$height),
        vmin = latest_numeric(heatmap_gid, "vmin", current_vmin),
        vmax = latest_numeric(heatmap_gid, "vmax", current_vmax),
        cmap = latest_string(heatmap_gid, "cmap", "custom")
      ),
      role = "ggplot_colorbar",
      mappableId = mappable_id,
      mappableIds = mappable_ids,
      layerIds = usage$layerIds,
      subplotIds = subplot_ids,
      scaleId = scale_id,
      guideId = colorbar_gid,
      scaleKey = scale_key,
      guideKey = guide_key,
      aesthetic = kind,
      source = list(artistClass = "ggplot_continuous_legend", axesIndex = 0, zorder = scale_index)
    )
  }
  objects
}

regex_escape <- function(value) {
  gsub("([][{}()+*^$|\\\\?.])", "\\\\\\1", value, perl = TRUE)
}

svg_escape_text <- function(value) {
  text <- as.character(value %||% "")
  text <- gsub("&", "&amp;", text, fixed = TRUE)
  text <- gsub("<", "&lt;", text, fixed = TRUE)
  text <- gsub(">", "&gt;", text, fixed = TRUE)
  text
}

inject_svg_text_ids <- function(svg, manifest, ggplot_obj = NULL) {
  # 1. Inject tick labels IDs if ggplot_obj is provided
  built <- tryCatch(ggplot2::ggplot_build(ggplot_obj), error = function(e) NULL)
  if (!is.null(built) && !is.null(built$layout) && !is.null(built$layout$panel_params)) {
    for (p_idx in seq_along(built$layout$panel_params)) {
      params <- built$layout$panel_params[[p_idx]]
      
      get_axis_labels <- function(axis_param) {
        labels <- NULL
        if (is.list(axis_param) || is.environment(axis_param)) {
          if (!is.null(axis_param$get_labels)) {
            labels <- tryCatch(axis_param$get_labels(), error = function(e) NULL)
          }
          if (is.null(labels)) {
            labels <- axis_param$labels
          }
          if (is.null(labels)) {
            labels <- axis_param$major_source
          }
        }
        labels <- labels[!is.na(labels) & nzchar(labels)]
        as.character(labels)
      }
      
      x_labels <- get_axis_labels(params$x)
      y_labels <- get_axis_labels(params$y)
      
      # Inject data-fig-id for X axis tick labels (individual xtick GIDs)
      for (l_idx in seq_along(x_labels)) {
        label <- x_labels[l_idx]
        escaped_text <- regex_escape(svg_escape_text(label))
        pattern <- paste0("<text\\b[^>]*>\\s*", escaped_text, "\\s*</text>")
        matches <- gregexpr(pattern, svg, perl = TRUE)[[1]]
        if (length(matches) == 1 && matches[[1]] == -1) next
        match_lengths <- attr(matches, "match.length")
        for (i in seq_along(matches)) {
          start <- matches[[i]]
          len <- match_lengths[[i]]
          if (start < 0 || len <= 0) next
          chunk <- substr(svg, start, start + len - 1)
          open_tag <- regmatches(chunk, regexpr("^<text\\b[^>]*>", chunk, perl = TRUE))
          if (!length(open_tag) || grepl("data-fig-id\\s*=", open_tag, perl = TRUE) || grepl("\\bid\\s*=", open_tag, perl = TRUE)) next
          
          tick_gid <- paste0("xtick.", p_idx - 1, ".", l_idx - 1)
          replacement <- sub("^<text\\b", paste0("<text id=\"", tick_gid, "\" data-fig-id=\"", tick_gid, "\""), chunk, perl = TRUE)
          svg <- paste0(
            substr(svg, 1, start - 1),
            replacement,
            substr(svg, start + len, nchar(svg))
          )
          break
        }
      }
      
      # Inject data-fig-id for Y axis tick labels (individual ytick GIDs)
      for (l_idx in seq_along(y_labels)) {
        label <- y_labels[l_idx]
        escaped_text <- regex_escape(svg_escape_text(label))
        pattern <- paste0("<text\\b[^>]*>\\s*", escaped_text, "\\s*</text>")
        matches <- gregexpr(pattern, svg, perl = TRUE)[[1]]
        if (length(matches) == 1 && matches[[1]] == -1) next
        match_lengths <- attr(matches, "match.length")
        for (i in seq_along(matches)) {
          start <- matches[[i]]
          len <- match_lengths[[i]]
          if (start < 0 || len <= 0) next
          chunk <- substr(svg, start, start + len - 1)
          open_tag <- regmatches(chunk, regexpr("^<text\\b[^>]*>", chunk, perl = TRUE))
          if (!length(open_tag) || grepl("data-fig-id\\s*=", open_tag, perl = TRUE) || grepl("\\bid\\s*=", open_tag, perl = TRUE)) next
          
          tick_gid <- paste0("ytick.", p_idx - 1, ".", l_idx - 1)
          replacement <- sub("^<text\\b", paste0("<text id=\"", tick_gid, "\" data-fig-id=\"", tick_gid, "\""), chunk, perl = TRUE)
          svg <- paste0(
            substr(svg, 1, start - 1),
            replacement,
            substr(svg, start + len, nchar(svg))
          )
          break
        }
      }
    }
  }

  # 2. Inject text IDs for other manifest text objects (supporting multiline split)
  objects <- manifest$objects %||% list()
  if (length(objects) == 0) return(svg)

  for (obj in objects) {
    if (!identical(obj$kind %||% "", "text")) next
    gid <- as.character(obj$id %||% "")
    if (!nzchar(gid)) next
    text <- as.character((obj$currentProps %||% list())$text %||% "")
    if (!nzchar(text)) next

    # Split multiline texts to inject ID for each line
    lines <- strsplit(text, "\n", fixed = TRUE)[[1]]
    lines <- lines[nzchar(lines)]
    if (length(lines) == 0) next

    for (line_text in lines) {
      escaped_text <- regex_escape(svg_escape_text(line_text))
      pattern <- paste0("<text\\b[^>]*>\\s*", escaped_text, "\\s*</text>")
      matches <- gregexpr(pattern, svg, perl = TRUE)[[1]]
      if (length(matches) == 1 && matches[[1]] == -1) next

      match_lengths <- attr(matches, "match.length")
      for (i in seq_along(matches)) {
        start <- matches[[i]]
        len <- match_lengths[[i]]
        if (start < 0 || len <= 0) next
        chunk <- substr(svg, start, start + len - 1)
        open_tag <- regmatches(chunk, regexpr("^<text\\b[^>]*>", chunk, perl = TRUE))
        if (!length(open_tag) || grepl("data-fig-id\\s*=", open_tag, perl = TRUE) || grepl("\\bid\\s*=", open_tag, perl = TRUE)) next

        # Stamp both id (unique) and data-fig-id (for grouping/selection)
        replacement <- sub("^<text\\b", paste0("<text id=\"", gid, "\" data-fig-id=\"", gid, "\""), chunk, perl = TRUE)
        svg <- paste0(
          substr(svg, 1, start - 1),
          replacement,
          substr(svg, start + len, nchar(svg))
        )
        break
      }
    }
  }

  svg
}

apply_svg_legend_text_edits <- function(svg, manifest) {
  objects <- manifest$objects %||% list()
  if (length(objects) == 0) return(svg)
  for (obj in objects) {
    if (!identical(obj$role %||% "", "legend_text")) next
    gid <- as.character(obj$id %||% "")
    props <- obj$currentProps %||% list()
    original_text <- as.character(props$originalText %||% "")
    next_text <- as.character(props$text %||% "")
    if (!nzchar(gid) || !nzchar(original_text) || !nzchar(next_text) || identical(original_text, next_text)) next

    old_escaped <- regex_escape(svg_escape_text(original_text))
    pattern <- paste0("<text\\b[^>]*>\\s*", old_escaped, "\\s*</text>")
    matches <- gregexpr(pattern, svg, perl = TRUE)[[1]]
    if (length(matches) == 1 && matches[[1]] == -1) next
    match_lengths <- attr(matches, "match.length")

    for (i in seq_along(matches)) {
      start <- matches[[i]]
      len <- match_lengths[[i]]
      if (start < 0 || len <= 0) next
      chunk <- substr(svg, start, start + len - 1)
      open_tag <- regmatches(chunk, regexpr("^<text\\b[^>]*>", chunk, perl = TRUE))
      if (!length(open_tag) || grepl("data-fig-id\\s*=", open_tag, perl = TRUE) || grepl("\\bid\\s*=", open_tag, perl = TRUE)) next

      replacement <- sub("^<text\\b", paste0("<text id=\"", gid, "\" data-fig-id=\"", gid, "\""), chunk, perl = TRUE)
      replacement <- sub(
        paste0(">\\s*", old_escaped, "\\s*</text>$"),
        paste0(">", svg_escape_text(next_text), "</text>"),
        replacement,
        perl = TRUE
      )
      svg <- paste0(
        substr(svg, 1, start - 1),
        replacement,
        substr(svg, start + len, nchar(svg))
      )
      break
    }
  }
  svg
}

layer_svg_plan <- function(plot_obj) {
  built <- tryCatch(ggplot2::ggplot_build(plot_obj), error = function(e) NULL)
  if (is.null(built) || is.null(built$data) || length(plot_obj$layers) == 0) return(list())

  plans <- list()
  for (i in seq_along(plot_obj$layers)) {
    geom <- geom_class(plot_obj$layers[[i]])
    kind <- layer_kind(geom)
    if (kind == "text") next
    data <- built$data[[i]]
    if (is.null(data) || nrow(data) == 0) next

    tags <- switch(
      kind,
      collection = c("circle", "path"),
      line = c("polyline", "path", "line"),
      patch = c("rect", "polygon", "path"),
      errorbar_container = c("polyline", "line", "path"),
      c("path", "polyline", "circle", "rect", "polygon", "line")
    )
    count <- switch(
      kind,
      line = max(1L, length(unique(data$group %||% 1L))),
      errorbar_container = max(1L, nrow(data)),
      max(1L, nrow(data))
    )
    row_indices <- if (kind == "line" && "group" %in% names(data)) {
      match(unique(data$group), data$group)
    } else {
      seq_len(min(count, nrow(data)))
    }
    plans[[length(plans) + 1]] <- list(
      gid = paste0("r.layer.", i - 1),
      kind = kind,
      tags = tags,
      count = count,
      row_indices = row_indices,
      layer_index = i
    )
  }
  plans
}

is_svg_data_candidate <- function(chunk) {
  if (grepl("\\bdata-fig-id\\s*=", chunk, perl = TRUE)) return(FALSE)
  # Skip non-styled geometric helpers (like clip-path elements which lack inline style attribute)
  if (!grepl("\\bstyle\\s*=", chunk, perl = TRUE)) return(FALSE)
  # Skip panel/background rectangles: white fill with no stroke
  if (
    grepl("^<rect\\b", chunk, perl = TRUE) &&
    grepl("fill:\\s*#FFFFFF", chunk, ignore.case = TRUE, perl = TRUE) &&
    grepl("stroke:\\s*none", chunk, ignore.case = TRUE, perl = TRUE)
  ) {
    return(FALSE)
  }
  # Skip clip-path defining rects (panel borders)
  if (
    grepl("^<rect\\b", chunk, perl = TRUE) &&
    grepl("stroke:\\s*none", chunk, ignore.case = TRUE, perl = TRUE) &&
    !grepl("fill:\\s*none", chunk, ignore.case = TRUE, perl = TRUE) &&
    grepl("clip-path", chunk, ignore.case = TRUE, perl = TRUE)
  ) {
    return(FALSE)
  }
  # Skip axis spine lines (stroke-only paths with no fill, typically used as frame borders)
  if (
    grepl("^<(path|polyline|line)\\b", chunk, perl = TRUE) &&
    grepl("fill:\\s*none", chunk, ignore.case = TRUE, perl = TRUE) &&
    grepl("stroke:\\s*#000000", chunk, ignore.case = TRUE, perl = TRUE) &&
    grepl("stroke-width:\\s*0\\.5", chunk, ignore.case = TRUE, perl = TRUE)
  ) {
    return(FALSE)
  }
  TRUE
}

colors_equal <- function(c1, c2) {
  if (is.null(c1) || is.null(c2) || is.na(c1) || is.na(c2)) return(FALSE)
  if (identical(c1, c2)) return(TRUE)
  rgb1 <- tryCatch(col2rgb(c1), error = function(e) NULL)
  rgb2 <- tryCatch(col2rgb(c2), error = function(e) NULL)
  if (is.null(rgb1) || is.null(rgb2)) {
    return(toupper(trimws(as.character(c1))) == toupper(trimws(as.character(c2))))
  }
  return(all(rgb1 == rgb2))
}

get_element_group_gid <- function(layer_index, row_index, default_layer_gid, built_data, scale_catalog) {
  if (length(built_data) < layer_index) {
    return(default_layer_gid)
  }

  data <- built_data[[layer_index]]
  if (is.null(data) || nrow(data) < row_index) {
    return(default_layer_gid)
  }

  row_data <- data[row_index, ]

  candidates <- character()
  for (entry in scale_catalog$entries %||% list()) {
    kind <- entry$kind
    val_in_data <- if (kind == "fill") row_data$fill else row_data$colour
    if (is.null(val_in_data) || is.na(val_in_data)) next

    for (j in seq_along(entry$colors)) {
      group_id <- paste0("r.group.", kind, ".", entry$ordinal, ".", j - 1)
      orig_color <- as.character(entry$colors[[j]])
      current_color <- latest_string(group_id, if (kind == "fill") "facecolor" else "color", orig_color)
      if (colors_equal(val_in_data, current_color)) {
        candidates <- c(candidates, group_id)
      }
    }
  }

  candidates <- unique(candidates)
  if (length(candidates) == 1) candidates[[1]] else default_layer_gid
}

inject_next_svg_tag_attrs <- function(svg, tags, gid, count, row_indices, layer_index, built_data, scale_catalog) {
  if (count <= 0 || length(tags) == 0 || !nzchar(gid)) return(svg)
  tag_pattern <- paste(tags, collapse = "|")
  pattern <- paste0("<(", tag_pattern, ")\\b[^>]*>")
  matches <- gregexpr(pattern, svg, perl = TRUE)[[1]]
  if (length(matches) == 1 && matches[[1]] == -1) return(svg)

  match_lengths <- attr(matches, "match.length")
  candidates <- list()
  for (i in seq_along(matches)) {
    start <- matches[[i]]
    len <- match_lengths[[i]]
    if (start < 0 || len <= 0) next
    chunk <- substr(svg, start, start + len - 1)
    if (!is_svg_data_candidate(chunk)) next
    candidates[[length(candidates) + 1]] <- list(start = start, len = len, chunk = chunk)
    if (length(candidates) >= count) break
  }
  if (length(candidates) == 0) return(svg)

  for (idx in rev(seq_along(candidates))) {
    candidate <- candidates[[idx]]
    row_index <- if (length(row_indices) >= idx) row_indices[[idx]] else idx
    resolved_gid <- get_element_group_gid(layer_index, row_index, gid, built_data, scale_catalog)
    replacement <- sub("^<([A-Za-z0-9:_-]+)\\b", paste0("<\\1 data-fig-id=\"", resolved_gid, "\""), candidate$chunk, perl = TRUE)
    svg <- paste0(
      substr(svg, 1, candidate$start - 1),
      replacement,
      substr(svg, candidate$start + candidate$len, nchar(svg))
    )
  }
  svg
}

inject_svg_layer_data_ids <- function(svg, plot_obj) {
  plans <- layer_svg_plan(plot_obj)
  if (length(plans) == 0) return(svg)
  built_data <- tryCatch(ggplot2::ggplot_build(plot_obj)$data, error = function(e) list())
  scale_catalog <- discrete_scale_catalog(plot_obj)
  for (plan in plans) {
    svg <- inject_next_svg_tag_attrs(svg, plan$tags, plan$gid, plan$count, plan$row_indices, plan$layer_index, built_data, scale_catalog)
  }
  svg
}

r_manifest_legend_id <- function(id) {
  if (grepl("^legend_(title|text|line|patch|collection)\\.0", id)) return("legend.0")
  NULL
}

r_manifest_string_values <- function(value) {
  if (is.null(value) || length(value) == 0) return(character())
  values <- tryCatch(
    as.character(unlist(value, recursive = TRUE, use.names = FALSE)),
    error = function(e) character()
  )
  values <- trimws(values[!is.na(values)])
  unique(values[nzchar(values)])
}

r_manifest_scalar_string <- function(value) {
  values <- r_manifest_string_values(value)
  if (length(values) == 1) values[[1]] else NULL
}

r_manifest_relation_scalar <- function(relation, key, value) {
  scalar <- r_manifest_scalar_string(value)
  if (!is.null(scalar)) relation[[key]] <- scalar
  relation
}

r_manifest_subplot_id <- function(obj) {
  explicit_subplot_ids <- r_manifest_string_values(obj[["subplotId"]])
  if (length(explicit_subplot_ids) == 1) return(explicit_subplot_ids[[1]])
  if (length(explicit_subplot_ids) > 1) return(NULL)
  plural_subplot_ids <- r_manifest_string_values(obj[["subplotIds"]])
  if (length(plural_subplot_ids) == 1) return(plural_subplot_ids[[1]])
  if (length(plural_subplot_ids) > 1) return(NULL)
  id <- as.character(obj$id %||% "")
  if (grepl("^subplot\\.", id)) return(id)
  tick_match <- regexec("^[xy]tick\\.([0-9]+)\\.", id)
  tick_parts <- regmatches(id, tick_match)[[1]]
  if (length(tick_parts) > 1) return(paste0("subplot.", tick_parts[[2]]))
  if (grepl("^r\\.text\\.", id)) {
    axes_index <- as.integer(obj$source$axesIndex %||% 0)
    return(paste0("subplot.", axes_index))
  }
  NULL
}

r_manifest_coordinate_space <- function(obj) {
  coord_system <- as.character(obj$currentProps$coord_system %||% "")
  if (coord_system %in% c("data", "axes", "figure", "display")) return(coord_system)
  id <- as.character(obj$id %||% "")
  kind <- as.character(obj$kind %||% "")
  if (grepl("^legend", id)) return("container")
  if (kind %in% c("subplot", "colorbar")) return("figure")
  if (kind %in% c("line", "collection", "patch", "heatmap", "errorbar_container", "boxplot_container", "violinplot_container")) return("data")
  if (!is.null(r_manifest_subplot_id(obj))) return("axes")
  "none"
}

r_manifest_identity <- function(obj) {
  id <- as.character(obj$id %||% "")
  kind <- as.character(obj$kind %||% "component")
  role <- as.character(obj$role %||% kind)
  legend_id <- r_manifest_legend_id(id)
  subplot_id <- r_manifest_subplot_id(obj)
  figure_level <- grepl("^(title|xlabel|ylabel|axis\\.[xy]|legend\\.0$|grid|spine\\.)", id)
  scope <- if (!is.null(legend_id) || grepl("^r\\.group\\.", id)) "container" else if (figure_level) "figure" else if (!is.null(subplot_id)) "subplot" else "figure"
  relation <- list()
  relation <- r_manifest_relation_scalar(relation, "parentId", obj[["parentId"]])
  if (!is.null(subplot_id) && !figure_level) relation[["subplotId"]] <- subplot_id
  explicit_subplot_ids <- unique(c(
    r_manifest_string_values(obj[["subplotIds"]]),
    if (length(r_manifest_string_values(obj[["subplotId"]])) > 1) r_manifest_string_values(obj[["subplotId"]]) else character()
  ))
  if (length(explicit_subplot_ids) > 0) relation[["subplotIds"]] <- as.list(explicit_subplot_ids)
  for (key in c(
    "layerId", "layerKey", "scaleId", "scaleKey", "guideId", "guideKey",
    "aesthetic", "groupKey", "dataKey", "facetKey", "axisKey"
  )) {
    relation <- r_manifest_relation_scalar(relation, key, obj[[key]])
  }
  layer_ids <- r_manifest_string_values(obj[["layerIds"]])
  if (length(layer_ids) > 0) {
    relation[["layerIds"]] <- as.list(layer_ids)
    if (is.null(relation[["layerId"]]) && length(layer_ids) == 1) relation[["layerId"]] <- layer_ids[[1]]
  }
  group_ids <- r_manifest_string_values(obj[["groupIds"]])
  if (length(group_ids) > 0) relation[["groupIds"]] <- as.list(group_ids)
  if (!is.null(legend_id)) relation[["legendId"]] <- legend_id
  for (key in c("legendId", "colorbarId", "mappableId", "annotationId", "arrowId", "textId")) {
    relation <- r_manifest_relation_scalar(relation, key, obj[[key]])
  }
  mappable_ids <- r_manifest_string_values(obj[["mappableIds"]])
  if (length(mappable_ids) > 0) relation[["mappableIds"]] <- as.list(mappable_ids)
  semantic_scope <- relation[["subplotId"]] %||% if (length(relation[["subplotIds"]] %||% list()) == 1) relation[["subplotIds"]][[1]] else "figure"
  semantic_key <- paste(role, semantic_scope, sep = ":")
  if (grepl("^r\\.group\\.", id)) {
    semantic_key <- paste("ggplot_group", relation$aesthetic %||% "unknown", relation$groupKey %||% id, sep = ":")
  } else if (grepl("^r\\.layer\\.", id)) {
    semantic_key <- paste(role, "layer", relation$layerKey %||% obj$source$layerSignature %||% role, sep = ":")
  } else if (kind == "subplot") {
    semantic_key <- paste("ggplot_panel", relation$facetKey %||% "root", sep = ":")
  } else if (grepl("^r\\.text\\.", id) && !is.null(relation$dataKey)) {
    semantic_key <- paste("ggplot_text", relation$layerKey %||% "layer", relation$facetKey %||% "root", relation$dataKey, sep = ":")
  } else if (!is.null(relation$dataKey) && role %in% c("legend_text", "xtick", "ytick")) {
    semantic_key <- paste(role, relation$facetKey %||% "root", relation$dataKey, sep = ":")
  }
  identity <- list(
    semanticKey = semantic_key,
    instanceKey = paste("r", scope, id, sep = ":"),
    scope = scope,
    coordinateSpace = r_manifest_coordinate_space(obj)
  )
  if (grepl("^r\\.(layer|group|heatmap)\\.", id) || kind %in% c("line", "collection", "patch", "heatmap", "errorbar_container", "boxplot_container", "violinplot_container")) {
    identity$seriesKey <- if (grepl("^r\\.group\\.", id)) {
      paste("r-series", relation$aesthetic %||% "unknown", relation$groupKey %||% id, sep = ":")
    } else {
      paste("r-series", semantic_key, sep = ":")
    }
  }
  if (length(relation) > 0) identity$relation <- relation
  identity
}

r_structural_relation <- function(identity) {
  relation <- identity$relation %||% list()
  stable_fields <- c(
    "aesthetic", "groupKey", "dataKey", "facetKey", "axisKey",
    "layerKey", "scaleKey", "guideKey"
  )
  relation[intersect(stable_fields, names(relation))]
}

r_manifest_stable_key <- function(obj, identity) {
  paste(
    "r",
    as.character(obj$kind %||% "component"),
    as.character(identity$semanticKey %||% obj$role %||% "object"),
    as.character(identity$seriesKey %||% "singleton"),
    sep = ":"
  )
}

r_manifest_structural_fingerprint <- function(obj, identity, stable_key) {
  structure <- list(
    kind = as.character(obj$kind %||% "component"),
    role = as.character(obj$role %||% obj$kind %||% "component"),
    stableKey = stable_key,
    semanticKey = identity$semanticKey %||% NULL,
    seriesKey = identity$seriesKey %||% NULL,
    coordinateSpace = identity$coordinateSpace %||% "none",
    relation = r_structural_relation(identity),
    artistClass = as.character(obj$source$artistClass %||% "unknown")
  )
  canonical <- jsonlite::toJSON(structure, auto_unbox = TRUE, null = "null", digits = NA)
  encoded <- jsonlite::base64_enc(charToRaw(enc2utf8(canonical)))
  paste0("r-v2:", gsub("[\\r\\n\\t ]+", "", encoded, perl = TRUE))
}

r_manifest_derived_effects <- function(prop) {
  if (prop %in% c("text", "fontsize", "fontfamily", "fontweight", "fontstyle", "rotation")) return(list("text_bounds"))
  if (prop == "position") return(list("object_bounds"))
  if (prop %in% c("left", "bottom", "width", "height", "aspect")) return(list("child_display_position"))
  if (prop %in% c("markerscale", "ncol", "handletextpad", "labelspacing", "columnspacing", "borderpad")) return(list("container_layout"))
  list()
}

r_manifest_property_capabilities <- function(obj) {
  editable <- unlist(obj$editable %||% list(), use.names = FALSE)
  identity <- obj$identity %||% r_manifest_identity(obj)
  relation <- identity$relation %||% list()
  unsafe_cross_figure <- c("text", "label", "title", "position", "left", "bottom", "width", "height", "limits", "aspect", "cmap", "vmin", "vmax")
  lapply(editable, function(prop) {
    scopes <- c("object")
    if (!is.null(obj$role) && !prop %in% c("position", "anchor_position")) scopes <- c(scopes, "group")
    scale_scoped <- !is.null(relation[["scaleId"]])
    if (!scale_scoped && (!is.null(relation[["subplotId"]]) || length(relation[["subplotIds"]] %||% list()) > 0)) {
      scopes <- c(scopes, "subplot")
    }
    if (!prop %in% c("position", "left", "bottom", "width", "height")) scopes <- c(scopes, "figure")
    if (!prop %in% unsafe_cross_figure) scopes <- c(scopes, "cross_figure")
    if (identical(as.character(obj$kind %||% ""), "subplot") && prop == "aspect") {
      scopes <- c("figure")
    }
    row_identity_unsupported <- grepl("^r\\.text\\.", as.character(obj$id %||% "")) && is.null(relation$dataKey)
    capability <- list(
      prop = as.character(prop),
      patchMode = "backend_patch",
      scopes = as.list(unique(scopes)),
      preview = if (prop == "position") "approximate" else "none",
      replay = if (row_identity_unsupported) "unsupported" else if (prop == "position") "conditional" else "stable"
    )
    if (prop == "position") {
      capability$coordinateSpace <- identity$coordinateSpace %||% "none"
    } else if (prop %in% c("left", "bottom", "width", "height")) {
      capability$coordinateSpace <- "figure"
    } else if (prop == "aspect") {
      capability$coordinateSpace <- "container"
    }
    derived_effects <- r_manifest_derived_effects(prop)
    if (length(derived_effects) > 0) capability$derivedEffects <- derived_effects
    capability
  })
}

attach_r_manifest_shadow_metadata <- function(obj) {
  obj$identity <- r_manifest_identity(obj)
  obj$stableKey <- r_manifest_stable_key(obj, obj$identity)
  obj$fingerprintVersion <- 2L
  obj$fingerprint <- r_manifest_structural_fingerprint(obj, obj$identity, obj$stableKey)
  obj$colorbarId <- NULL
  obj$mappableId <- NULL
  obj$mappableIds <- NULL
  obj$annotationId <- NULL
  obj$arrowId <- NULL
  obj$textId <- NULL
  obj$layerId <- NULL
  obj$layerIds <- NULL
  obj$layerKey <- NULL
  obj$groupIds <- NULL
  obj$scaleId <- NULL
  obj$scaleKey <- NULL
  obj$guideId <- NULL
  obj$guideKey <- NULL
  obj$legendId <- NULL
  obj$aesthetic <- NULL
  obj$groupKey <- NULL
  obj$dataKey <- NULL
  obj$facetKey <- NULL
  obj$axisKey <- NULL
  obj$propertyCapabilities <- r_manifest_property_capabilities(obj)
  obj
}

unwrap_manifest_value <- function(value) {
  if (is.data.frame(value) && nrow(value) == 1 && ncol(value) == 1) {
    return(unwrap_manifest_value(value[[1]][[1]]))
  }
  if (is.list(value) && length(value) == 1 && is.null(names(value))) {
    return(unwrap_manifest_value(value[[1]]))
  }
  value
}

present_manifest_value <- function(value) {
  value <- unwrap_manifest_value(value)
  if (is.null(value) || length(value) == 0) return(FALSE)
  if (all(is.na(value))) return(FALSE)
  TRUE
}

identity_manifest_value <- function(identity, field) {
  identity <- unwrap_manifest_value(identity)
  if (is.null(identity)) return(NULL)
  if (is.data.frame(identity)) {
    if (!field %in% names(identity) || nrow(identity) == 0) return(NULL)
    return(unwrap_manifest_value(identity[[field]][[1]]))
  }
  if (!is.list(identity) || is.null(identity[[field]])) return(NULL)
  unwrap_manifest_value(identity[[field]])
}

r_identity_relation_value <- function(identity) {
  relation <- identity_manifest_value(identity, "relation")
  relation <- unwrap_manifest_value(relation)
  if (is.data.frame(relation) && nrow(relation) == 1) return(as.list(relation[1, , drop = FALSE]))
  if (!is.list(relation)) return(list())
  relation
}

r_stable_relation_value <- function(identity) {
  relation <- r_identity_relation_value(identity)
  stable_fields <- c(
    "aesthetic", "groupKey", "dataKey", "facetKey", "axisKey",
    "layerKey", "scaleKey", "guideKey"
  )
  relation[intersect(stable_fields, names(relation))]
}

r_normalize_structural_fingerprint <- function(value) {
  fingerprint <- as.character(unwrap_manifest_value(value) %||% "")
  if (!startsWith(fingerprint, "r-v2:")) return(fingerprint)
  gsub("[\\r\\n\\t ]+", "", fingerprint, perl = TRUE)
}

r_identity_json_equal <- function(actual, expected) {
  identical(
    jsonlite::toJSON(unwrap_manifest_value(actual), auto_unbox = TRUE, null = "null", digits = NA),
    jsonlite::toJSON(unwrap_manifest_value(expected), auto_unbox = TRUE, null = "null", digits = NA)
  )
}

r_entry_identity_evidence <- function(entry) {
  fingerprint_version <- suppressWarnings(as.integer(unwrap_manifest_value(entry$fingerprintVersion)))
  evidence <- list()
  if (present_manifest_value(entry$stableKey)) evidence$stableKey <- as.character(unwrap_manifest_value(entry$stableKey))
  if (
    length(fingerprint_version) == 1 && !is.na(fingerprint_version) && fingerprint_version == 2 &&
    present_manifest_value(entry$fingerprint)
  ) {
    evidence$fingerprint <- as.character(unwrap_manifest_value(entry$fingerprint))
  }
  for (field in c("semanticKey", "seriesKey")) {
    value <- identity_manifest_value(entry$identity, field)
    if (present_manifest_value(value)) evidence[[field]] <- as.character(value)
  }
  relation <- r_stable_relation_value(entry$identity)
  if (length(relation) > 0) evidence$relation <- relation
  evidence
}

r_object_matches_identity_evidence <- function(object, evidence) {
  if (!is.null(evidence$stableKey) && !identical(evidence$stableKey, as.character(object$stableKey %||% ""))) return(FALSE)
  if (!is.null(evidence$fingerprint) && !identical(
    r_normalize_structural_fingerprint(evidence$fingerprint),
    r_normalize_structural_fingerprint(object$fingerprint)
  )) return(FALSE)
  if (!is.null(evidence$semanticKey) && !identical(evidence$semanticKey, as.character(identity_manifest_value(object$identity, "semanticKey") %||% ""))) return(FALSE)
  if (!is.null(evidence$seriesKey) && !identical(evidence$seriesKey, as.character(identity_manifest_value(object$identity, "seriesKey") %||% ""))) return(FALSE)
  if (!is.null(evidence$relation)) {
    actual_relation <- r_stable_relation_value(object$identity)
    for (field in names(evidence$relation)) {
      if (!field %in% names(actual_relation) || !r_identity_json_equal(actual_relation[[field]], evidence$relation[[field]])) return(FALSE)
    }
  }
  TRUE
}

resolve_r_edit_entries <- function(manifest, entries) {
  objects <- manifest$objects %||% list()
  object_by_id <- setNames(objects, vapply(objects, function(obj) as.character(obj$id %||% ""), character(1)))
  accepted <- list()
  rejected <- list()
  warnings <- list()

  reject_entry <- function(entry, patch_index, type, gid, prop, message, extra = list()) {
    warnings[[length(warnings) + 1]] <<- c(list(
      type = type,
      gid = gid,
      prop = prop,
      patchIndex = patch_index,
      message = message
    ), extra)
    rejected[[length(rejected) + 1]] <<- entry
  }

  for (index in seq_along(entries)) {
    entry <- entries[[index]]
    gid <- as.character(unwrap_manifest_value(entry$gid) %||% "")
    prop <- as.character(unwrap_manifest_value(entry$prop) %||% "")
    if (!nzchar(gid) || !nzchar(prop) || identical(gid, "global")) {
      resolved <- entry
      resolved[[".__requestedEntry"]] <- entry
      resolved[[".__patchIndex"]] <- index - 1L
      accepted[[length(accepted) + 1]] <- resolved
      next
    }

    exact_object <- object_by_id[[gid]]
    evidence <- r_entry_identity_evidence(entry)
    if (length(evidence) == 0) {
      legacy_axis_gid <- if (grepl("^axis\\.[xy]\\.[0-9]+$", gid)) {
        sub("^axis\\.([xy])\\.[0-9]+$", "axis.\\1.0", gid)
      } else {
        NULL
      }
      if (is.null(exact_object) && !is.null(legacy_axis_gid)) {
        exact_object <- object_by_id[[legacy_axis_gid]]
      }
      if (is.null(exact_object)) {
        reject_entry(entry, index - 1L, "missing_gid", gid, prop, paste0("R manifest is missing gid ", gid, "."))
        next
      }
      resolved <- entry
      resolved[[".__requestedEntry"]] <- entry
      resolved[[".__patchIndex"]] <- index - 1L
      if (!identical(as.character(exact_object$id), gid)) {
        resolved[[".__resolvedGid"]] <- as.character(exact_object$id)
        resolved$gid <- as.character(exact_object$id)
      }
      accepted[[length(accepted) + 1]] <- resolved
      next
    }

    candidates <- Filter(function(object) {
      r_object_matches_identity_evidence(object, evidence)
    }, objects)
    if (length(candidates) == 0) {
      reject_entry(
        entry,
        index - 1L,
        "identity_mismatch",
        gid,
        prop,
        paste0(gid, " identity does not uniquely match any current R manifest object."),
        list(expected = evidence)
      )
      next
    }
    if (length(candidates) > 1) {
      reject_entry(
        entry,
        index - 1L,
        "ambiguous_identity",
        gid,
        prop,
        paste0(gid, " identity matches multiple current R manifest objects."),
        list(candidateGids = as.list(vapply(candidates, function(object) as.character(object$id), character(1))))
      )
      next
    }

    resolved <- entry
    resolved[[".__requestedEntry"]] <- entry
    resolved[[".__patchIndex"]] <- index - 1L
    resolved[[".__resolvedGid"]] <- as.character(candidates[[1]]$id)
    resolved$gid <- as.character(candidates[[1]]$id)
    accepted[[length(accepted) + 1]] <- resolved
  }

  list(accepted = accepted, rejected = rejected, warnings = warnings)
}

manifest_values_equal <- function(prop, actual, expected) {
  actual <- unwrap_manifest_value(actual)
  expected <- unwrap_manifest_value(expected)
  if (grepl("color|colour|facecolor|edgecolor", prop, ignore.case = TRUE)) {
    return(colors_equal(actual, expected))
  }
  actual_numeric <- suppressWarnings(as.numeric(actual))
  expected_numeric <- suppressWarnings(as.numeric(expected))
  if (
    length(actual_numeric) == 1 && length(expected_numeric) == 1 &&
    !is.na(actual_numeric) && !is.na(expected_numeric)
  ) {
    return(abs(actual_numeric - expected_numeric) <= 1e-9)
  }
  identical(
    jsonlite::toJSON(actual, auto_unbox = TRUE, null = "null", digits = NA),
    jsonlite::toJSON(expected, auto_unbox = TRUE, null = "null", digits = NA)
  )
}

confirm_r_edit_entries <- function(manifest, entries, resolution = list(rejected = list(), warnings = list())) {
  objects <- manifest$objects %||% list()
  object_by_id <- setNames(objects, vapply(objects, function(obj) as.character(obj$id %||% ""), character(1)))
  applied <- list()
  rejected <- resolution$rejected %||% list()
  warnings <- c(resolution$warnings %||% list(), renderer_patch_warnings)

  forced_warning_for <- function(gid, prop) {
    any(vapply(renderer_patch_warnings, function(item) {
      identical(as.character(item$gid %||% ""), gid) &&
        identical(as.character(item$prop %||% ""), prop)
    }, logical(1)))
  }

  reject_entry <- function(entry, patch_index, type, gid, prop, message, extra = list()) {
    warning <- c(list(
      type = type,
      gid = gid,
      prop = prop,
      patchIndex = patch_index,
      message = message
    ), extra)
    warnings[[length(warnings) + 1]] <<- warning
    rejected[[length(rejected) + 1]] <<- entry
  }

  for (index in seq_along(entries)) {
    entry <- entries[[index]]
    requested_entry <- entry[[".__requestedEntry"]] %||% entry
    patch_index <- suppressWarnings(as.integer(entry[[".__patchIndex"]] %||% (index - 1L)))
    gid <- as.character(unwrap_manifest_value(entry$gid) %||% "")
    requested_gid <- as.character(unwrap_manifest_value(requested_entry$gid) %||% gid)
    prop <- as.character(unwrap_manifest_value(entry$prop) %||% "")
    if (!nzchar(gid)) {
      reject_entry(requested_entry, patch_index, "missing_gid", requested_gid, prop, "R patch is missing a gid.")
      next
    }
    if (!nzchar(prop)) {
      reject_entry(requested_entry, patch_index, "unsupported_prop", requested_gid, prop, "R patch is missing a property name.")
      next
    }
    if (forced_warning_for(gid, prop)) {
      rejected[[length(rejected) + 1]] <- requested_entry
      next
    }

    if (identical(gid, "global")) {
      field <- manifest$globals[[prop]]
      if (is.null(field)) {
        reject_entry(requested_entry, patch_index, "unsupported_prop", requested_gid, prop, paste0("R global property is not declared: ", prop, "."))
        next
      }
      if (!manifest_values_equal(prop, field$value, entry$value)) {
        reject_entry(requested_entry, patch_index, "no_setter", requested_gid, prop, paste0("R renderer did not confirm ", requested_gid, ".", prop, "."))
        next
      }
      applied[[length(applied) + 1]] <- requested_entry
      next
    }

    object <- object_by_id[[gid]]
    if (is.null(object)) {
      reject_entry(requested_entry, patch_index, "missing_gid", requested_gid, prop, paste0("R manifest is missing gid ", gid, "."))
      next
    }
    editable <- as.character(unlist(object$editable %||% list(), use.names = FALSE))
    capabilities <- object$propertyCapabilities %||% list()
    supported <- prop %in% editable && any(vapply(capabilities, function(capability) {
      identical(as.character(capability$prop %||% ""), prop) &&
        !identical(as.character(capability$replay %||% ""), "unsupported")
    }, logical(1)))
    if (!supported) {
      reject_entry(requested_entry, patch_index, "unsupported_prop", requested_gid, prop, paste0(gid, ".", prop, " is not replayable in the R manifest."))
      next
    }

    entry_stable_key <- unwrap_manifest_value(entry$stableKey)
    if (present_manifest_value(entry_stable_key) && !identical(as.character(entry_stable_key), as.character(object$stableKey %||% ""))) {
      reject_entry(requested_entry, patch_index, "identity_mismatch", requested_gid, prop, paste0(gid, " stableKey does not match the R manifest object."), list(field = "stableKey"))
      next
    }
    entry_fingerprint_version <- suppressWarnings(as.integer(unwrap_manifest_value(entry$fingerprintVersion)))
    if (
      length(entry_fingerprint_version) == 1 && !is.na(entry_fingerprint_version) && entry_fingerprint_version == 2 &&
      identical(as.integer(object$fingerprintVersion %||% 0), 2) &&
      present_manifest_value(entry$fingerprint) &&
      !identical(
        r_normalize_structural_fingerprint(entry$fingerprint),
        r_normalize_structural_fingerprint(object$fingerprint)
      )
    ) {
      reject_entry(requested_entry, patch_index, "identity_mismatch", requested_gid, prop, paste0(gid, " fingerprint does not match the R manifest object."), list(field = "fingerprint"))
      next
    }
    identity_rejected <- FALSE
    for (identity_field in c("semanticKey", "seriesKey")) {
      expected_identity <- identity_manifest_value(object$identity, identity_field)
      actual_identity <- identity_manifest_value(entry$identity, identity_field)
      if (present_manifest_value(actual_identity) && !identical(as.character(actual_identity), as.character(expected_identity %||% ""))) {
        reject_entry(requested_entry, patch_index, "identity_mismatch", requested_gid, prop, paste0(gid, " identity.", identity_field, " does not match the R manifest object."), list(field = paste0("identity.", identity_field)))
        identity_rejected <- TRUE
        break
      }
    }
    if (identity_rejected) next

    current_value <- object$currentProps[[prop]]
    if (!manifest_values_equal(prop, current_value, entry$value)) {
      reject_entry(requested_entry, patch_index, "no_setter", requested_gid, prop, paste0("R renderer did not confirm ", gid, ".", prop, "."))
      next
    }
    acknowledgement <- requested_entry
    if (!identical(requested_gid, gid)) acknowledgement$resolvedGid <- gid
    applied[[length(applied) + 1]] <- acknowledgement
  }

  list(
    applied = applied,
    skipped = rejected,
    warnings = warnings,
    conflict = length(rejected) > 0
  )
}

build_ggplot_manifest <- function(plot_obj, svg = "") {
  layout_bounds <- svg_plot_layout_bounds(svg)
  title_style <- style_for_gid("title.0", default_title)
  x_label_style <- axis_label_style_for_gid("axis.x.0", "xlabel.0", default_label)
  y_label_style <- axis_label_style_for_gid("axis.y.0", "ylabel.0", default_label)
  x_tick_style <- axis_style_for_gid("axis.x.0", default_tick)
  y_tick_style <- axis_style_for_gid("axis.y.0", default_tick)
  legend_style <- style_for_gid("legend.0", default_legend)

  title_text <- latest_string("title.0", "text", plot_obj$labels$title %||% "")
  x_text <- axis_label_text_for_gid("axis.x.0", "xlabel.0", plot_obj$labels$x %||% "")
  y_text <- axis_label_text_for_gid("axis.y.0", "ylabel.0", plot_obj$labels$y %||% "")
  legend_title <- latest_string(
    "legend_title.0",
    "text",
    latest_string("legend.0", "title", legend_title_from_scale(plot_obj))
  )

  legend_visible_bool <- latest_bool("legend.0", "visible", TRUE)
  legend_loc <- latest_string("legend.0", "loc", "right")
  legend_face <- latest_string("legend.0", "facecolor", "white")
  legend_edge <- latest_string("legend.0", "edgecolor", "none")
  legend_lw <- latest_numeric("legend.0", "linewidth", 0.5)
  legend_alpha <- latest_numeric("legend.0", "alpha", 1.0)
  legend_ncol <- max(1L, as.integer(latest_numeric("legend.0", "ncol", default_legend$ncol)))
  legend_markerscale <- max(0.1, latest_numeric("legend.0", "markerscale", default_legend$markerscale))
  legend_handletextpad <- max(0, latest_numeric("legend.0", "handletextpad", default_legend$handletextpad))
  legend_labelspacing <- max(0, latest_numeric("legend.0", "labelspacing", default_legend$labelspacing))
  legend_columnspacing <- max(0, latest_numeric("legend.0", "columnspacing", default_legend$columnspacing))
  legend_borderpad <- max(0, latest_numeric("legend.0", "borderpad", default_legend$borderpad))

  grid_visible <- latest_bool("grid.0", "visible", TRUE)
  grid_color <- latest_string("grid.0", "color", "#E5E5E5")
  grid_width <- latest_numeric("grid.0", "linewidth", 0.5)
  grid_style_str <- latest_string("grid.0", "linestyle", "solid")
  grid_alpha <- latest_numeric("grid.0", "alpha", 1.0)
  discrete_catalog <- discrete_scale_catalog(plot_obj)
  discrete_guide_keys <- sort(unique(vapply(
    discrete_catalog$entries,
    function(entry) as.character(entry$guideKey %||% ""),
    character(1)
  )))
  discrete_guide_keys <- discrete_guide_keys[nzchar(discrete_guide_keys)]
  legend_guide_key <- if (length(discrete_guide_keys) > 0) {
    paste(discrete_guide_keys, collapse = "|")
  } else {
    "ggplot-guide:discrete"
  }

  objects <- list(
    manifest_text_object("title.0", "figure_title", title_text, title_style),
    manifest_text_object("xlabel.0", "x_axis_label", x_text, x_label_style),
    manifest_text_object("ylabel.0", "y_axis_label", y_text, y_label_style),
    manifest_axis_object("axis.x.0", "x_axis_ticks", x_tick_style, plot_obj),
    manifest_axis_object("axis.y.0", "y_axis_ticks", y_tick_style, plot_obj),
    list(
      id = "legend.0",
      kind = "legend",
      label = "legend",
      editable = list("title", "fontsize", "fontfamily", "fontweight", "fontstyle", "color", "visible", "loc", "ncol", "markerscale", "handletextpad", "labelspacing", "columnspacing", "borderpad", "facecolor", "edgecolor", "linewidth", "alpha"),
      currentProps = list(
        title = legend_title,
        fontsize = legend_style$fontsize,
        fontfamily = legend_style$fontfamily,
        fontweight = legend_style$fontweight,
        fontstyle = legend_style$fontstyle,
        color = legend_style$color,
        visible = legend_visible_bool,
        loc = legend_loc,
        ncol = legend_ncol,
        markerscale = legend_markerscale,
        handletextpad = legend_handletextpad,
        labelspacing = legend_labelspacing,
        columnspacing = legend_columnspacing,
        borderpad = legend_borderpad,
        facecolor = legend_face,
        edgecolor = legend_edge,
        linewidth = legend_lw,
        alpha = legend_alpha
      ),
      role = "legend",
      guideKey = legend_guide_key,
      source = list(artistClass = "ggplot_legend", axesIndex = 0)
    ),
    list(
      id = "grid.0",
      kind = "grid",
      label = "grid",
      editable = list("visible", "color", "linewidth", "linestyle", "alpha"),
      currentProps = list(
        visible = grid_visible,
        color = grid_color,
        linewidth = grid_width,
        linestyle = grid_style_str,
        alpha = grid_alpha
      ),
      role = "grid",
      source = list(artistClass = "ggplot_grid", axesIndex = 0)
    )
  )

  manifest_spine_object <- function(id, side) {
    visible <- latest_bool(id, "visible", TRUE)
    color <- latest_string(id, "color", "black")
    linewidth <- latest_numeric(id, "linewidth", 0.5)
    list(
      id = id,
      kind = "spine",
      label = paste0("spine_", side),
      editable = list("visible", "color", "linewidth"),
      currentProps = list(
        visible = visible,
        color = color,
        linewidth = linewidth
      ),
      role = paste0("spine_", side),
      source = list(artistClass = "ggplot_spine", axesIndex = 0)
    )
  }
  
  objects[[length(objects) + 1]] <- manifest_spine_object("spine.bottom.0", "bottom")
  objects[[length(objects) + 1]] <- manifest_spine_object("spine.left.0", "left")
  objects[[length(objects) + 1]] <- manifest_spine_object("spine.top.0", "top")
  objects[[length(objects) + 1]] <- manifest_spine_object("spine.right.0", "right")
  objects <- c(objects, manifest_legend_text_objects(plot_obj, legend_title, legend_style, legend_guide_key))
  
  # Inject individual xtick and ytick objects into objects list
  built <- tryCatch(ggplot2::ggplot_build(plot_obj), error = function(e) NULL)
  if (!is.null(built) && !is.null(built$layout) && !is.null(built$layout$panel_params)) {
    panel_keys <- facet_panel_key_map(plot_obj)
    get_axis_labels <- function(axis_param) {
      labels <- NULL
      if (is.list(axis_param) || is.environment(axis_param)) {
        if (!is.null(axis_param$get_labels)) {
          labels <- tryCatch(axis_param$get_labels(), error = function(e) NULL)
        }
        if (is.null(labels)) {
          labels <- axis_param$labels
        }
        if (is.null(labels)) {
          labels <- axis_param$major_source
        }
      }
      labels <- labels[!is.na(labels) & nzchar(labels)]
      as.character(labels)
    }

    for (p_idx in seq_along(built$layout$panel_params)) {
      params <- built$layout$panel_params[[p_idx]]
      x_labels <- get_axis_labels(params$x)
      y_labels <- get_axis_labels(params$y)

      # Add xtick objects
      if (length(x_labels) > 0) {
        for (i in seq_along(x_labels)) {
          id <- paste0("xtick.", p_idx - 1, ".", i - 1)
          objects[[length(objects) + 1]] <- list(
            id = id,
            kind = "xtick",
            label = "xtick",
            editable = list("fontsize", "fontfamily", "fontweight", "fontstyle", "color", "rotation"),
            currentProps = list(
              text = x_labels[[i]],
              fontsize = latest_numeric(id, "fontsize", x_tick_style$fontsize),
              fontfamily = latest_string(id, "fontfamily", x_tick_style$fontfamily),
              fontweight = latest_string(id, "fontweight", x_tick_style$fontweight),
              fontstyle = latest_string(id, "fontstyle", x_tick_style$fontstyle),
              color = latest_string(id, "color", x_tick_style$color),
              rotation = latest_numeric(id, "rotation", x_tick_style$rotation)
            ),
            role = "xtick",
            dataKey = paste0("x:", x_labels[[i]]),
            facetKey = panel_keys[[as.character(p_idx)]] %||% "root",
            axisKey = "x",
            source = list(artistClass = "ggplot_tick_label", axesIndex = p_idx - 1)
          )
        }
      }

      # Add ytick objects
      if (length(y_labels) > 0) {
        for (i in seq_along(y_labels)) {
          id <- paste0("ytick.", p_idx - 1, ".", i - 1)
          objects[[length(objects) + 1]] <- list(
            id = id,
            kind = "ytick",
            label = "ytick",
            editable = list("fontsize", "fontfamily", "fontweight", "fontstyle", "color", "rotation"),
            currentProps = list(
              text = y_labels[[i]],
              fontsize = latest_numeric(id, "fontsize", y_tick_style$fontsize),
              fontfamily = latest_string(id, "fontfamily", y_tick_style$fontfamily),
              fontweight = latest_string(id, "fontweight", y_tick_style$fontweight),
              fontstyle = latest_string(id, "fontstyle", y_tick_style$fontstyle),
              color = latest_string(id, "color", y_tick_style$color),
              rotation = latest_numeric(id, "rotation", y_tick_style$rotation)
            ),
            role = "ytick",
            dataKey = paste0("y:", y_labels[[i]]),
            facetKey = panel_keys[[as.character(p_idx)]] %||% "root",
            axisKey = "y",
            source = list(artistClass = "ggplot_tick_label", axesIndex = p_idx - 1)
          )
        }
      }
    }
  }

  if (length(plot_obj$layers) > 0) {
    layer_objects <- lapply(
      seq_along(plot_obj$layers),
      function(i) manifest_layer_object(plot_obj$layers[[i]], i, plot_obj$mapping)
    )
    objects <- c(objects, layer_objects)
  }
  text_layer_objects <- manifest_text_layer_objects(plot_obj)
  if (length(text_layer_objects) > 0) {
    objects <- c(objects, text_layer_objects)
  }
  single_subplot <- manifest_single_subplot_object(plot_obj, layout_bounds)
  if (!is.null(single_subplot)) {
    objects <- c(objects, list(single_subplot))
  }
  facet_objects <- manifest_facet_objects(plot_obj)
  if (length(facet_objects) > 0) {
    objects <- c(objects, facet_objects)
    strip_object <- manifest_facet_strip_object(plot_obj)
    if (!is.null(strip_object)) {
      objects <- c(objects, list(strip_object))
    }
  }
  built_plot <- tryCatch(ggplot2::ggplot_build(plot_obj)$plot, error = function(e) plot_obj)
  scale_semantics <- detect_discrete_scale_semantics(built_plot)
  if (length(scale_semantics$objects) > 0) {
    objects <- c(objects, scale_semantics$objects)
  }
  if (length(scale_semantics$objects) > 0) {
    for (object_index in seq_along(objects)) {
      object_id <- as.character(objects[[object_index]]$id %||% "")
      if (grepl("^r\\.layer\\.", object_id)) {
        linked_groups <- Filter(function(group_obj) object_id %in% unlist(group_obj$layerIds %||% list()), scale_semantics$objects)
        if (length(linked_groups) > 0) {
          objects[[object_index]]$groupIds <- as.list(vapply(linked_groups, function(group_obj) group_obj$id, character(1)))
          objects[[object_index]]$subplotIds <- as.list(unique(unlist(lapply(linked_groups, function(group_obj) group_obj$subplotIds %||% list()))))
        }
      } else if (identical(object_id, "legend.0")) {
        objects[[object_index]]$groupIds <- as.list(vapply(scale_semantics$objects, function(group_obj) group_obj$id, character(1)))
      }
    }
  }
  continuous_colorbar_objects <- manifest_continuous_colorbar_objects(plot_obj, layout_bounds)
  if (length(continuous_colorbar_objects) > 0) {
    objects <- c(objects, continuous_colorbar_objects)
  }

  objects <- lapply(objects, attach_r_manifest_shadow_metadata)

  unsupported_objects <- Filter(function(obj) identical(obj$kind %||% "", "unsupported"), objects)
  editable_object_count <- sum(vapply(objects, function(obj) length(obj$editable %||% list()) > 0, logical(1)))
  unsupported_artists <- lapply(unsupported_objects, function(obj) list(
    class = as.character(obj$source$artistClass %||% "unknown_ggplot_geom"),
    count = 1,
    reason = as.character(obj$currentProps$unsupportedReason %||% "No stable SciFigure write-back adapter.")
  ))
  extension_scales <- Filter(function(scale_obj) {
    aesthetics <- as.character(scale_obj$aesthetics %||% character())
    any(grepl("ggnewscale|new_aes", aesthetics, ignore.case = TRUE, perl = TRUE))
  }, built_plot$scales$scales %||% list())
  if (length(extension_scales) > 0) {
    unsupported_artists[[length(unsupported_artists) + 1]] <- list(
      class = "ggnewscale_or_renamed_aesthetic",
      count = length(extension_scales),
      reason = "Multiple renamed aesthetics require a dedicated scale-to-layer adapter; SciFigure will not merge them into the active color/fill scale."
    )
  }
  unsupported_count <- length(unsupported_objects) + length(extension_scales)

  kind_counts <- table(vapply(objects, function(obj) obj$kind, character(1)))
  kind_count <- function(kind) {
    if (!kind %in% names(kind_counts)) return(0L)
    as.integer(kind_counts[[kind]])
  }
  by_kind <- list(
    text = list(count = kind_count("text"), editableProps = list("text", "fontsize", "fontfamily", "fontweight", "fontstyle", "color")),
    axis_x = list(count = kind_count("axis_x"), editableProps = list("label", "label_fontsize", "label_color", "tick_labelsize", "tick_labelfamily", "tick_labelcolor", "tick_fontweight", "tick_fontstyle", "limits", "tick_rotation", "tick_direction", "tick_length", "tick_width", "tick_color", "tick_pad")),
    axis_y = list(count = kind_count("axis_y"), editableProps = list("label", "label_fontsize", "label_color", "tick_labelsize", "tick_labelfamily", "tick_labelcolor", "tick_fontweight", "tick_fontstyle", "limits", "tick_rotation", "tick_direction", "tick_length", "tick_width", "tick_color", "tick_pad")),
    legend = list(count = kind_count("legend"), editableProps = list("title", "fontsize", "fontfamily", "fontweight", "fontstyle", "color", "visible", "loc", "ncol", "markerscale", "handletextpad", "labelspacing", "columnspacing", "borderpad", "facecolor", "edgecolor", "linewidth", "alpha")),
    collection = list(count = kind_count("collection"), editableProps = list("color", "facecolor", "size", "alpha")),
    line = list(count = kind_count("line"), editableProps = list("color", "linewidth", "linestyle", "alpha")),
    patch = list(count = kind_count("patch"), editableProps = list("facecolor", "edgecolor", "linewidth", "alpha")),
    errorbar_container = list(count = kind_count("errorbar_container"), editableProps = list("color", "linewidth", "alpha")),
    boxplot_container = list(count = kind_count("boxplot_container"), editableProps = list("color", "linewidth", "alpha", "box_color", "median_color")),
    violinplot_container = list(count = kind_count("violinplot_container"), editableProps = list("color", "facecolor", "edgecolor", "linewidth", "alpha")),
    xtick = list(count = kind_count("xtick"), editableProps = list("fontsize", "fontfamily", "fontweight", "fontstyle", "color", "rotation")),
    ytick = list(count = kind_count("ytick"), editableProps = list("fontsize", "fontfamily", "fontweight", "fontstyle", "color", "rotation")),
    subplot = list(count = kind_count("subplot"), editableProps = list("aspect")),
    facet_strip = list(count = if (any(vapply(objects, function(obj) identical(obj$id, "facet.strip.0"), logical(1)))) 1L else 0L, editableProps = list("fontsize", "fontfamily", "fontweight", "fontstyle", "color")),
    heatmap = list(count = kind_count("heatmap"), editableProps = list("cmap", "vmin", "vmax", "alpha")),
    colorbar = list(count = kind_count("colorbar"), editableProps = list("label", "tick_fontsize", "visible", "left", "bottom", "width", "height")),
    unsupported = list(count = kind_count("unsupported"), editableProps = list()),
    spine = list(count = kind_count("spine"), editableProps = list("visible", "color", "linewidth")),
    grid = list(count = kind_count("grid"), editableProps = list("visible", "color", "linewidth", "linestyle", "alpha"))
  )

  list(
    generatedBy = "r_svg",
    globals = list(
      "figure.width_in" = list(type = "number", value = width, min = 2, max = 30, step = 0.1),
      "figure.height_in" = list(type = "number", value = height, min = 2, max = 30, step = 0.1)
    ),
    objects = objects,
    palettes = scale_semantics$palettes,
    groups = scale_semantics$groups,
    bindings = scale_semantics$bindings,
    capabilities = list(localPatch = FALSE, backendPatch = TRUE, codePatch = FALSE),
    coverageReport = list(
      summary = list(
        recognized = length(objects),
        editable = editable_object_count,
        readonly = length(objects) - editable_object_count,
        unsupported = unsupported_count
      ),
      byKind = by_kind,
      unsupportedArtists = unsupported_artists
    ),
    unsupportedNotes = list(
      "R ggplot2 semantic editing currently covers labels, theme text, whole-layer geom styles, manual color/fill scales, facet panel discovery, and continuous heatmap/colorbar scales.",
      "R facet subplot aspect uses ggplot theme(aspect.ratio); independent left/bottom/width/height panel bounds are not equivalent to Matplotlib axes bounds.",
      "Drag-position replay and per-facet independent label styling are not enabled in this phase."
    )
  )
}

monotonic_ms <- function() {
  as.numeric(proc.time()[["elapsed"]]) * 1000
}

render_started_ms <- monotonic_ms()
timing_breakdown <- list(
  scriptExecutionMs = 0,
  svgSerializeMs = 0,
  manifestBuildMs = 0,
  svgPostprocessMs = 0
)

result <- tryCatch({
  env <- new.env(parent = globalenv())
  env$uploaded_data <- if (!is.null(payload$dataPayload$custom_data)) payload$dataPayload$custom_data else payload$dataPayload
  env$uploaded_file_paths <- if (!is.null(payload$uploaded_file_paths)) payload$uploaded_file_paths else list()
  env$csv_json_paths <- if (!is.null(payload$csv_json_paths)) payload$csv_json_paths else list()
  env$dataPayload <- payload$dataPayload
  read_scifigure_csv_bridge <- function(file, args) {
    file_value <- as.character(file)
    if (length(file_value) == 0 || is.na(file_value[1]) || !nzchar(file_value[1])) {
      return(NULL)
    }
    candidates <- unique(c(file_value[1], basename(file_value[1])))
    sidecar <- NULL
    for (candidate in candidates) {
      if (!is.null(env$csv_json_paths[[candidate]])) {
        sidecar <- as.character(env$csv_json_paths[[candidate]])
        break
      }
    }
    if (is.null(sidecar) || !nzchar(sidecar)) {
      return(NULL)
    }
    sidecar_path <- sidecar
    if (!file.exists(sidecar_path)) {
      sidecar_path <- file.path(getwd(), sidecar)
    }
    if (!file.exists(sidecar_path)) {
      return(NULL)
    }
    table_payload <- jsonlite::fromJSON(sidecar_path, simplifyDataFrame = TRUE)
    columns <- as.character(table_payload$columns %||% character())
    rows <- table_payload$rows
    if (is.null(rows)) {
      df <- as.data.frame(setNames(rep(list(logical()), length(columns)), columns), check.names = FALSE)
    } else {
      df <- as.data.frame(rows, stringsAsFactors = FALSE, check.names = FALSE)
      if (length(columns) == length(names(df))) {
        names(df) <- columns
      }
    }
    check_names <- if (!is.null(args$check.names)) isTRUE(args$check.names) else TRUE
    if (check_names) {
      names(df) <- make.names(names(df), unique = TRUE)
    }
    df
  }
  env$read.csv <- function(file, ...) {
    args <- list(...)
    bridged <- read_scifigure_csv_bridge(file, args)
    if (!is.null(bridged)) {
      return(bridged)
    }
    if (is.null(args$fileEncoding)) args$fileEncoding <- "UTF-8"
    if (is.null(args$quote)) args$quote <- "\""
    if (is.null(args$comment.char)) args$comment.char <- ""
    do.call(utils::read.csv, c(list(file = file), args))
  }
  env$read.table <- function(file, ...) {
    args <- list(...)
    bridged <- read_scifigure_csv_bridge(file, args)
    if (!is.null(bridged)) {
      return(bridged)
    }
    if (is.null(args$fileEncoding)) args$fileEncoding <- "UTF-8"
    if (is.null(args$quote)) args$quote <- "\""
    if (is.null(args$comment.char)) args$comment.char <- ""
    do.call(utils::read.table, c(list(file = file), args))
  }

  oldwd <- getwd()
  if (!is.null(payload$cwd) && nzchar(payload$cwd) && dir.exists(payload$cwd)) {
    setwd(payload$cwd)
  }
  on.exit(setwd(oldwd), add = TRUE)
  runtime_inventory$workingDirectory <- safe_runtime_path(getwd())
  runtime_inventory$temporaryDirectory <- safe_runtime_path(tempdir())
  runtime_inventory$timezone <- safe_runtime_string(Sys.timezone())
  runtime_inventory$environment <- runtime_environment_contract()

  if (requireNamespace("svglite", quietly = TRUE)) {
    svglite::svglite(file = tmp_svg, width = width, height = height)
  } else {
    grDevices::svg(filename = tmp_svg, width = width, height = height, onefile = TRUE)
  }
  on.exit({
    try(grDevices::dev.off(), silent = TRUE)
  }, add = TRUE)

  script_execution_started_ms <- monotonic_ms()
  withCallingHandlers({
    eval(parse(text = script), envir = env)
    candidate_names <- c("p", "plot_obj", "figure", "fig")
    for (name in candidate_names) {
      if (exists(name, envir = env, inherits = FALSE)) {
        obj <- get(name, envir = env)
        if (inherits(obj, "ggplot")) {
          source_entries <- edit_entries
          source_patch_warnings <- renderer_patch_warnings
          edit_entries <- list()
          baseline_manifest <- build_ggplot_manifest(obj, "")
          edit_entries <- source_entries
          renderer_patch_warnings <- source_patch_warnings
          r_edit_resolution <- resolve_r_edit_entries(baseline_manifest, source_entries)
          edit_entries <- r_edit_resolution$accepted
          obj <- apply_ggplot_edits(obj)
          assign(name, obj, envir = env)
          print(obj)
          break
        }
      }
    }
  }, warning = function(w) {
    warnings_collected <<- c(warnings_collected, conditionMessage(w))
    add_runtime_warning_diagnostic(w)
    invokeRestart("muffleWarning")
  })
  timing_breakdown$scriptExecutionMs <- max(0, round(monotonic_ms() - script_execution_started_ms))

  try(grDevices::dev.off(), silent = TRUE)
  svg_serialize_started_ms <- monotonic_ms()
  svg <- paste(readLines(tmp_svg, warn = FALSE, encoding = "UTF-8"), collapse = "\n")
  timing_breakdown$svgSerializeMs <- max(0, round(monotonic_ms() - svg_serialize_started_ms))

  ggplot_obj <- NULL
  for (name in c("p", "plot_obj", "figure", "fig")) {
    if (exists(name, envir = env, inherits = FALSE)) {
      candidate <- get(name, envir = env)
      if (inherits(candidate, "ggplot")) {
        ggplot_obj <- candidate
        break
      }
    }
  }

  manifest_build_started_ms <- monotonic_ms()
  manifest <- if (!is.null(ggplot_obj)) {
    build_ggplot_manifest(ggplot_obj, svg)
  } else {
    list(
      generatedBy = "r_svg",
      globals = list(
        "figure.width_in" = list(type = "number", value = width, min = 2, max = 30, step = 0.1),
        "figure.height_in" = list(type = "number", value = height, min = 2, max = 30, step = 0.1)
      ),
      objects = list(),
      palettes = list(),
      groups = list(),
      bindings = list(svgIdAttr = "id"),
      capabilities = list(localPatch = FALSE, backendPatch = FALSE, codePatch = FALSE),
      coverageReport = list(
        summary = list(recognized = 0, editable = 0, readonly = 0, unsupported = 1),
        byKind = list(),
        unsupportedArtists = list(list(
          class = "base_r_or_grid_output",
          count = 1,
          reason = "Rendered for preview/export, but no assigned ggplot object provides stable semantic write-back targets."
        ))
      ),
      unsupportedNotes = list(
        "R base plot rendering is currently SVG preview/export only.",
        "ggplot2 label/theme semantic editing is enabled when a ggplot object is assigned to p, plot_obj, figure, or fig."
      )
    )
  }
  timing_breakdown$manifestBuildMs <- max(0, round(monotonic_ms() - manifest_build_started_ms))

  svg_postprocess_started_ms <- monotonic_ms()
  if (!is.null(ggplot_obj)) {
    svg <- apply_svg_legend_text_edits(svg, manifest)
    svg <- inject_svg_text_ids(svg, manifest, ggplot_obj)
    svg <- inject_svg_layer_data_ids(svg, ggplot_obj)
  }
  timing_breakdown$svgPostprocessMs <- max(0, round(monotonic_ms() - svg_postprocess_started_ms))
  timing_breakdown$totalMs <- max(0, round(monotonic_ms() - render_started_ms))
  patch_confirmation <- confirm_r_edit_entries(manifest, edit_entries, r_edit_resolution)

  list(
    status = "success",
    svg = svg,
    manifest = manifest,
    revision = 1,
    applied = patch_confirmation$applied,
    skipped = patch_confirmation$skipped,
    conflict = patch_confirmation$conflict,
    warnings = c(as.list(warnings_collected), patch_confirmation$warnings),
    diagnostic = if (length(runtime_warning_diagnostics) > 0) runtime_warning_diagnostics[[1]] else NULL,
    warningDiagnostics = runtime_warning_diagnostics,
    runtimeInventory = runtime_inventory,
    timingMs = timing_breakdown$totalMs,
    timingBreakdown = timing_breakdown
  )
}, error = function(e) {
  timing_breakdown$totalMs <- max(0, round(monotonic_ms() - render_started_ms))
  list(
    status = "error",
    message = paste("R script failed:", conditionMessage(e)),
    traceback = paste(utils::capture.output(traceback()), collapse = "\n"),
    diagnostic = runtime_diagnostic(e, payload),
    warningDiagnostics = runtime_warning_diagnostics,
    runtimeInventory = runtime_inventory,
    timingMs = timing_breakdown$totalMs,
    timingBreakdown = timing_breakdown
  )
})

try(unlink(tmp_svg), silent = TRUE)
emit_json(result)
quit(status = 0, save = "no", runLast = FALSE)
