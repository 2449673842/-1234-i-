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

has_edit_for_any_gid <- function(gids, prop) {
  gids <- as.character(unlist(gids, use.names = FALSE))
  any(vapply(gids, function(gid) has_edit(gid, prop), logical(1)))
}

latest_value_for_gids <- function(gids, prop, fallback) {
  candidates <- as.character(unlist(gids, use.names = FALSE))
  value <- fallback
  for (entry in edit_entries) {
    if (as.character(entry$gid) %in% candidates && identical(as.character(entry$prop), prop)) {
      value <- entry$value
      if (is.list(value) && length(value) == 1 && is.null(names(value))) value <- value[[1]]
    }
  }
  value
}

latest_numeric_for_gids <- function(gids, prop, fallback) {
  value <- suppressWarnings(as.numeric(latest_value_for_gids(gids, prop, fallback)))
  if (length(value) == 0 || !is.finite(value[[1]])) fallback else value[[1]]
}

latest_string_for_gids <- function(gids, prop, fallback) {
  value <- latest_value_for_gids(gids, prop, fallback)
  if (is.null(value) || length(value) == 0) fallback else as.character(value[[1]])
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

entry_relation_string <- function(entry, field) {
  value <- entry$identity$relation[[field]] %||% NULL
  while (is.list(value) && length(value) == 1 && is.null(names(value))) value <- value[[1]]
  if (is.null(value) || length(value) == 0 || is.na(value[[1]])) return("")
  as.character(value[[1]])
}

has_relation_edit <- function(field, relation_value, prop, gid = "") {
  if (nzchar(gid) && has_edit(gid, prop)) return(TRUE)
  any(vapply(edit_entries, function(entry) {
    identical(as.character(entry$prop %||% ""), prop) &&
      identical(entry_relation_string(entry, field), as.character(relation_value))
  }, logical(1)))
}

latest_relation_bool <- function(field, relation_value, prop, fallback, gid = "") {
  value <- if (nzchar(gid)) latest_value(gid, prop, fallback) else fallback
  for (entry in edit_entries) {
    if (
      identical(as.character(entry$prop %||% ""), prop) &&
      identical(entry_relation_string(entry, field), as.character(relation_value))
    ) {
      value <- entry$value
      while (is.list(value) && length(value) == 1 && is.null(names(value))) value <- value[[1]]
    }
  }
  if (is.logical(value)) return(isTRUE(value[[1]]))
  text <- tolower(as.character(value[[1]] %||% fallback))
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
  axis_pattern <- if (grepl("^axis\\.x\\.", gid)) "^axis\\.x\\.\\d+$" else if (grepl("^axis\\.y\\.", gid)) "^axis\\.y\\.\\d+$" else paste0("^", gid, "$")

  weight <- latest_matching_string(axis_pattern, "tick_fontweight", latest_string(gid, "tick_fontweight", latest_string(gid, "fontweight", defaults$fontweight)))
  style <- latest_matching_string(axis_pattern, "tick_fontstyle", latest_string(gid, "tick_fontstyle", latest_string(gid, "fontstyle", defaults$fontstyle)))

  fontsize <- latest_matching_numeric(axis_pattern, "tick_labelsize", latest_numeric(gid, "tick_labelsize", latest_numeric(gid, "fontsize", defaults$fontsize)))
  fontfamily <- latest_matching_string(axis_pattern, "tick_labelfamily", latest_string(gid, "tick_labelfamily", latest_string(gid, "fontfamily", defaults$fontfamily)))
  color <- latest_matching_string(axis_pattern, "tick_labelcolor", latest_string(gid, "tick_labelcolor", latest_string(gid, "color", defaults$color)))
  rotation <- latest_matching_numeric(axis_pattern, "tick_rotation", latest_numeric(gid, "tick_rotation", defaults$rotation))

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
  value <- if (has_edit("r.facet.layout.0", "aspect")) {
    latest_value("r.facet.layout.0", "aspect", "auto")
  } else {
    latest_matching_value("^subplot\\.\\d+$", "aspect", "auto")
  }
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

layer_stat_class <- function(layer) {
  classes <- class(layer$stat)
  if (length(classes) == 0) return("StatIdentity")
  classes[[1]]
}

layer_position_class <- function(layer) {
  classes <- class(layer$position)
  if (length(classes) == 0) return("PositionIdentity")
  classes[[1]]
}

R_DIAGRAM_TYPES <- c("network", "path", "sem")
R_DIAGRAM_ROLE_MAP <- list(
  node = "diagram_node",
  edge = "diagram_edge",
  arrow = "diagram_arrow",
  node_label = "diagram_node_label",
  coefficient_label = "diagram_coefficient_label",
  fit_annotation = "diagram_fit_annotation",
  group = "diagram_group"
)

r_semantic_identifier <- function(value, field) {
  text <- trimws(as.character(value %||% "")[[1]])
  if (!nzchar(text)) stop(paste0(field, " must be a non-empty identifier"))
  if (nchar(text, type = "chars") > 256 || grepl("[[:cntrl:]]", text, perl = TRUE)) {
    stop(paste0(field, " contains unsupported characters or is too long"))
  }
  text
}

r_diagram_semantic_metadata <- function(
  diagram_id,
  role,
  object_id,
  diagram_type = "sem",
  node_id = NULL,
  edge_id = NULL,
  source_node_id = NULL,
  target_node_id = NULL,
  layout_editable = FALSE
) {
  diagram_id_text <- r_semantic_identifier(diagram_id, "diagram_id")
  role_text <- tolower(r_semantic_identifier(role, "role"))
  object_id_text <- r_semantic_identifier(object_id, "object_id")
  diagram_type_text <- tolower(r_semantic_identifier(diagram_type, "diagram_type"))
  if (is.null(R_DIAGRAM_ROLE_MAP[[role_text]])) stop(paste0("unsupported diagram role: ", role_text))
  if (!diagram_type_text %in% R_DIAGRAM_TYPES) stop(paste0("unsupported diagram_type: ", diagram_type_text))

  optional <- list(
    nodeId = if (!is.null(node_id)) r_semantic_identifier(node_id, "node_id") else NULL,
    edgeId = if (!is.null(edge_id)) r_semantic_identifier(edge_id, "edge_id") else NULL,
    sourceNodeId = if (!is.null(source_node_id)) r_semantic_identifier(source_node_id, "source_node_id") else NULL,
    targetNodeId = if (!is.null(target_node_id)) r_semantic_identifier(target_node_id, "target_node_id") else NULL
  )
  if (identical(role_text, "node")) {
    optional$nodeId <- object_id_text
  } else if (identical(role_text, "edge")) {
    optional$edgeId <- object_id_text
    if (is.null(optional$sourceNodeId) || is.null(optional$targetNodeId)) {
      stop("edge semantics require source_node_id and target_node_id")
    }
  } else if (identical(role_text, "arrow") && is.null(optional$edgeId)) {
    stop("arrow semantics require edge_id")
  } else if (identical(role_text, "node_label") && is.null(optional$nodeId)) {
    stop("node_label semantics require node_id")
  } else if (identical(role_text, "coefficient_label") && is.null(optional$edgeId)) {
    stop("coefficient_label semantics require edge_id")
  }

  c(list(
    family = "diagram",
    semanticRole = R_DIAGRAM_ROLE_MAP[[role_text]],
    diagramRole = role_text,
    diagramId = diagram_id_text,
    diagramType = diagram_type_text,
    diagramObjectId = object_id_text,
    layoutEditable = isTRUE(layout_editable)
  ), Filter(Negate(is.null), optional))
}

r_layer_diagram_metadata <- function(layer) {
  metadata <- layer$.scifigure_diagram %||% NULL
  if (!is.list(metadata) || !identical(metadata$family %||% "", "diagram")) return(NULL)
  metadata
}

scifigure_semantic_layer <- function(
  layer,
  diagram_id,
  role,
  object_id,
  diagram_type = "sem",
  node_id = NULL,
  edge_id = NULL,
  source_node_id = NULL,
  target_node_id = NULL,
  layout_editable = FALSE
) {
  if (is.null(layer$geom) || is.null(layer$stat)) stop("scifigure_semantic_layer requires one ggplot2 layer")
  metadata <- r_diagram_semantic_metadata(
    diagram_id = diagram_id,
    role = role,
    object_id = object_id,
    diagram_type = diagram_type,
    node_id = node_id,
    edge_id = edge_id,
    source_node_id = source_node_id,
    target_node_id = target_node_id,
    layout_editable = layout_editable
  )
  geom <- geom_class(layer)
  allowed_geoms <- switch(
    metadata$diagramRole,
    node = c("GeomPoint", "GeomJitter", "GeomCol", "GeomBar", "GeomTile", "GeomRect"),
    edge = c("GeomLine", "GeomPath", "GeomSegment", "GeomCurve"),
    arrow = c("GeomSegment", "GeomCurve"),
    node_label = c("GeomText", "GeomLabel"),
    coefficient_label = c("GeomText", "GeomLabel"),
    fit_annotation = c("GeomText", "GeomLabel"),
    group = c("GeomRect", "GeomTile", "GeomCol", "GeomBar"),
    character()
  )
  if (!geom %in% allowed_geoms) {
    stop(paste0(metadata$diagramRole, " semantics do not support ggplot geom ", geom))
  }
  arrow <- (layer$geom_params %||% list())$arrow %||% NULL
  if (identical(metadata$diagramRole, "edge") && !is.null(arrow)) {
    stop("edge semantics with an arrow must use a separate semantic arrow layer")
  }
  if (identical(metadata$diagramRole, "arrow") && is.null(arrow)) {
    stop("arrow semantics require a GeomSegment/GeomCurve layer with grid::arrow()")
  }
  layer$.scifigure_diagram <- metadata
  layer$.scifigure_identity_key <- paste(
    "diagram", metadata$diagramId, metadata$semanticRole, metadata$diagramObjectId, geom,
    sep = ":"
  )
  layer
}

r_parse_scifigure_semantic_gid <- function(value) {
  marker <- as.character(value %||% "")[[1]]
  prefix <- "scifigure-sem-v1:"
  if (!startsWith(marker, prefix)) return(NULL)
  query <- substring(marker, nchar(prefix) + 1L)
  parts <- strsplit(query, "&", fixed = TRUE)[[1]]
  fields <- list()
  for (part in parts) {
    pair <- strsplit(part, "=", fixed = TRUE)[[1]]
    if (length(pair) != 2L) return(NULL)
    key <- utils::URLdecode(pair[[1]])
    if (nzchar(key) && !is.null(fields[[key]])) return(NULL)
    fields[[key]] <- utils::URLdecode(pair[[2]])
  }
  tryCatch(r_diagram_semantic_metadata(
    diagram_id = fields$diagram,
    role = fields$role,
    object_id = fields$id,
    diagram_type = fields$type %||% "sem",
    node_id = fields$node,
    edge_id = fields$edge,
    source_node_id = fields$source,
    target_node_id = fields$target
  ), error = function(e) NULL)
}

r_clone_layer_with_data <- function(layer, data) {
  clone <- ggplot2::ggproto(NULL, layer)
  clone$data <- data
  clone
}

r_expand_scifigure_semantic_layers <- function(plot_obj) {
  if (!inherits(plot_obj, "ggplot") || length(plot_obj$layers) == 0) return(plot_obj)
  expanded <- list()
  for (layer in plot_obj$layers) {
    if (!is.null(r_layer_diagram_metadata(layer))) {
      expanded[[length(expanded) + 1L]] <- layer
      next
    }
    source_data <- layer$data
    if (is.null(source_data) || inherits(source_data, "waiver")) source_data <- plot_obj$data
    source_data <- tryCatch(as.data.frame(source_data), error = function(e) NULL)
    marker_name <- if (!is.null(source_data) && ".scifigure_semantic_gid" %in% names(source_data)) {
      ".scifigure_semantic_gid"
    } else if (!is.null(source_data) && "scifigure_semantic_gid" %in% names(source_data)) {
      "scifigure_semantic_gid"
    } else {
      NULL
    }
    if (is.null(marker_name) || nrow(source_data) == 0) {
      expanded[[length(expanded) + 1L]] <- layer
      next
    }

    marker_values <- as.character(source_data[[marker_name]])
    processed <- rep(FALSE, nrow(source_data))
    for (row_index in seq_len(nrow(source_data))) {
      if (processed[[row_index]]) next
      marker <- marker_values[[row_index]]
      blank_marker <- is.na(marker) || !nzchar(trimws(marker))
      matching_rows <- if (blank_marker) {
        which(is.na(marker_values) | !nzchar(trimws(marker_values)))
      } else {
        which(!is.na(marker_values) & marker_values == marker)
      }
      matching_rows <- matching_rows[!processed[matching_rows]]
      processed[matching_rows] <- TRUE
      if (blank_marker) {
        expanded[[length(expanded) + 1L]] <- r_clone_layer_with_data(
          layer,
          source_data[matching_rows, , drop = FALSE]
        )
        next
      }

      metadata <- r_parse_scifigure_semantic_gid(marker)
      if (is.null(metadata)) {
        stop(paste0("Invalid .scifigure_semantic_gid at row ", row_index, "."))
      }
      semantic_layer <- r_clone_layer_with_data(layer, source_data[matching_rows, , drop = FALSE])
      semantic_layer <- scifigure_semantic_layer(
        semantic_layer,
        diagram_id = metadata$diagramId,
        role = metadata$diagramRole,
        object_id = metadata$diagramObjectId,
        diagram_type = metadata$diagramType,
        node_id = metadata$nodeId,
        edge_id = metadata$edgeId,
        source_node_id = metadata$sourceNodeId,
        target_node_id = metadata$targetNodeId,
        layout_editable = metadata$layoutEditable %||% FALSE
      )
      expanded[[length(expanded) + 1L]] <- semantic_layer
    }
  }
  plot_obj$layers <- expanded
  plot_obj
}

r_diagram_gid_token <- function(value) {
  text <- as.character(value %||% "")[[1]]
  utf8_bytes <- charToRaw(enc2utf8(text))
  namespace <- if (all(as.integer(utf8_bytes) <= 0x7f)) "a_" else "b_"
  encoded <- jsonlite::base64_enc(utf8_bytes)
  encoded <- gsub("+", "-", encoded, fixed = TRUE)
  encoded <- gsub("/", "_", encoded, fixed = TRUE)
  encoded <- sub("=+$", "", encoded, perl = TRUE)
  paste0(namespace, encoded)
}

r_diagram_object_gid <- function(metadata) {
  if (is.null(metadata)) return(NULL)
  family <- switch(
    metadata$semanticRole,
    diagram_node = "node",
    diagram_edge = "edge",
    diagram_arrow = "arrow",
    diagram_group = "group",
    diagram_node_label = "text",
    diagram_coefficient_label = "text",
    diagram_fit_annotation = "text",
    "object"
  )
  paste(
    "r",
    "diagram",
    family,
    r_diagram_gid_token(metadata$diagramType),
    r_diagram_gid_token(metadata$diagramId),
    r_diagram_gid_token(metadata$semanticRole),
    r_diagram_gid_token(metadata$diagramObjectId),
    sep = "."
  )
}

assert_unique_r_diagram_gids <- function(objects) {
  object_ids <- vapply(
    objects %||% list(),
    function(object) as.character(object$id %||% ""),
    character(1)
  )
  diagram_ids <- object_ids[grepl("^r\\.diagram\\.", object_ids, perl = TRUE)]
  duplicates <- unique(diagram_ids[duplicated(diagram_ids)])
  if (length(duplicates) > 0) {
    stop(sprintf(
      "Duplicate R diagram GID generated from explicit semantic identity: %s",
      paste(duplicates, collapse = ", ")
    ))
  }
  invisible(TRUE)
}

r_layer_manifest_gid <- function(layer, index, include_text = FALSE) {
  metadata <- r_layer_diagram_metadata(layer)
  if (!is.null(metadata) && (include_text || !geom_class(layer) %in% c("GeomText", "GeomLabel"))) {
    return(r_diagram_object_gid(metadata))
  }
  paste0("r.layer.", index - 1)
}

is_point_layer <- function(layer) {
  geom_class(layer) %in% c("GeomPoint", "GeomJitter")
}

is_line_adapter_layer <- function(layer) {
  geom_class(layer) %in% c("GeomLine", "GeomPath", "GeomSmooth", "GeomStep")
}

is_segment_curve_adapter_layer <- function(layer) {
  geom_class(layer) %in% c("GeomSegment", "GeomCurve")
}

is_bar_adapter_layer <- function(layer) {
  geom_class(layer) %in% c("GeomCol", "GeomBar")
}

is_errorbar_adapter_layer <- function(layer) {
  geom_class(layer) %in% c("GeomErrorbar", "GeomErrorbarh", "GeomLinerange", "GeomPointrange", "GeomCrossbar")
}

is_boxplot_adapter_layer <- function(layer) {
  identical(geom_class(layer), "GeomBoxplot")
}

is_violin_adapter_layer <- function(layer) {
  identical(geom_class(layer), "GeomViolin")
}

is_ribbon_area_adapter_layer <- function(layer) {
  geom_class(layer) %in% c("GeomRibbon", "GeomArea")
}

is_tile_raster_rect_adapter_layer <- function(layer) {
  geom_class(layer) %in% c("GeomTile", "GeomRaster", "GeomRect")
}

is_contour_adapter_layer <- function(layer) {
  geom_class(layer) %in% c("GeomContour", "GeomContourFilled")
}

is_contour_filled_adapter_layer <- function(layer) {
  identical(geom_class(layer), "GeomContourFilled")
}

is_step_adapter_layer <- function(layer) {
  identical(geom_class(layer), "GeomStep")
}

is_histogram_adapter_layer <- function(layer) {
  identical(geom_class(layer), "GeomBar") && identical(layer_stat_class(layer), "StatBin")
}

is_freqpoly_adapter_layer <- function(layer) {
  identical(geom_class(layer), "GeomPath") && identical(layer_stat_class(layer), "StatBin")
}

layer_adapter_class <- function(layer) {
  geom <- geom_class(layer)
  position <- layer_position_class(layer)
  if (is_histogram_adapter_layer(layer)) return("GeomHistogram")
  if (is_freqpoly_adapter_layer(layer)) return("GeomFreqpoly")
  if (geom %in% c("GeomPoint", "GeomJitter") && grepl("^PositionJitter", position)) {
    return("GeomJitter")
  }
  geom
}

layer_kind <- function(geom) {
  if (geom %in% c("GeomPoint", "GeomJitter", "GeomDotplot")) return("collection")
  if (geom %in% c("GeomText", "GeomLabel")) return("text")
  if (geom %in% c("GeomLine", "GeomPath", "GeomSmooth", "GeomStep", "GeomSegment", "GeomCurve", "GeomHline", "GeomVline", "GeomAbline", "GeomDensity", "GeomFreqpoly")) return("line")
  if (geom %in% c("GeomBoxplot")) return("boxplot_container")
  if (geom %in% c("GeomViolin")) return("violinplot_container")
  if (geom %in% c("GeomCol", "GeomBar", "GeomTile", "GeomRaster", "GeomRect", "GeomRibbon", "GeomArea")) return("patch")
  if (geom %in% c("GeomContour")) return("contour")
  if (geom %in% c("GeomContourFilled")) return("contourf")
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
    GeomStep = "ggplot step layer",
    GeomSegment = "ggplot segment layer",
    GeomCurve = "ggplot curve layer",
    GeomHistogram = "ggplot histogram layer",
    GeomFreqpoly = "ggplot frequency polygon layer",
    GeomCol = "ggplot column layer",
    GeomBar = "ggplot bar layer",
    GeomErrorbar = "ggplot errorbar layer",
    GeomErrorbarh = "ggplot horizontal errorbar layer",
    GeomLinerange = "ggplot linerange layer",
    GeomPointrange = "ggplot pointrange layer",
    GeomCrossbar = "ggplot crossbar layer",
    GeomText = "ggplot text layer",
    GeomLabel = "ggplot label layer",
    GeomBoxplot = "ggplot boxplot layer",
    GeomViolin = "ggplot violin layer",
    GeomRibbon = "ggplot ribbon layer",
    GeomArea = "ggplot area layer",
    GeomSmooth = "ggplot smooth layer",
    GeomTile = "ggplot tile layer",
    GeomRaster = "ggplot raster layer",
    GeomRect = "ggplot rectangle layer",
    GeomContour = "ggplot contour layer",
    GeomContourFilled = "ggplot filled contour layer",
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

first_present_value <- function(values, fallback = NULL) {
  if (is.null(values) || length(values) == 0) return(fallback)
  for (value in values) {
    if (is.null(value) || length(value) == 0 || is.na(value[[1]])) next
    return(value[[1]])
  }
  fallback
}

layer_data_values <- function(data, name) {
  if (is.null(data) || !name %in% names(data)) return(list())
  values <- data[[name]]
  values <- values[!is.na(values)]
  as.list(values)
}

point_shape_value <- function(value, fallback = 19) {
  if (is.null(value) || length(value) == 0 || is.na(value[[1]])) return(fallback)
  numeric_value <- suppressWarnings(as.numeric(value[[1]]))
  if (length(numeric_value) == 1 && is.finite(numeric_value)) return(numeric_value)
  as.character(value[[1]])
}

point_shapes_are_fillable <- function(values) {
  if (length(values) == 0) return(FALSE)
  numeric_values <- suppressWarnings(as.numeric(unlist(values, use.names = FALSE)))
  length(numeric_values) > 0 && all(is.finite(numeric_values)) && all(numeric_values %in% 21:25)
}

point_layer_rendered_shapes <- function(layer, built_data = NULL) {
  params <- layer_params(layer)
  default_shape <- ggplot2::GeomPoint$default_aes$shape %||% 19
  shape_values <- layer_data_values(built_data, "shape")
  if (length(shape_values) == 0) {
    shape_values <- list(param_value(params, c("shape"), default_shape))
  }
  unique(unlist(lapply(shape_values, point_shape_value), use.names = FALSE))
}

point_layer_final_shape <- function(layer, gid, built_data = NULL) {
  params <- layer_params(layer)
  rendered_shapes <- point_layer_rendered_shapes(layer, built_data)
  fallback <- if (length(rendered_shapes) > 0) rendered_shapes[[1]] else ggplot2::GeomPoint$default_aes$shape %||% 19
  point_shape_value(latest_value(gid, "marker", fallback), fallback)
}

point_layer_final_fillable <- function(layer, gid, built_data = NULL) {
  if (has_edit(gid, "marker")) {
    return(point_shapes_are_fillable(list(point_layer_final_shape(layer, gid, built_data))))
  }
  point_shapes_are_fillable(as.list(point_layer_rendered_shapes(layer, built_data)))
}

latest_alias_value <- function(gid, props, fallback) {
  value <- fallback
  for (entry in edit_entries) {
    if (identical(as.character(entry$gid), gid) && as.character(entry$prop) %in% props) {
      value <- entry$value
      if (is.list(value) && length(value) == 1 && is.null(names(value))) value <- value[[1]]
    }
  }
  value
}

latest_alias_numeric <- function(gid, props, fallback) {
  value <- suppressWarnings(as.numeric(latest_alias_value(gid, props, fallback)))
  if (length(value) == 0 || !is.finite(value[[1]])) return(as.numeric(fallback))
  value[[1]]
}

point_layer_current_props <- function(layer, gid, built_data = NULL, plot_mapping = NULL) {
  params <- layer_params(layer)
  default_aes <- ggplot2::GeomPoint$default_aes
  effective_mapping <- r_effective_layer_mapping(layer, plot_mapping)
  shapes <- point_layer_rendered_shapes(layer, built_data)
  marker <- point_layer_final_shape(layer, gid, built_data)
  fillable <- point_layer_final_fillable(layer, gid, built_data)

  base_size <- suppressWarnings(as.numeric(param_value(params, c("size"), default_aes$size %||% 1.5)))
  if (length(base_size) == 0 || !is.finite(base_size[[1]])) base_size <- 1.5
  size_scale <- max(0.01, latest_numeric(gid, "size_scale", layer$.scifigure_size_scale %||% 1))
  rendered_sizes <- suppressWarnings(as.numeric(unlist(layer_data_values(built_data, "size"), use.names = FALSE)))
  rendered_sizes <- rendered_sizes[is.finite(rendered_sizes)]
  if (length(rendered_sizes) == 0) rendered_sizes <- base_size[[1]]
  rendered_sizes <- rendered_sizes * size_scale

  color_fallback <- as.character(first_present_value(
    layer_data_values(built_data, "colour"),
    param_value(params, c("colour", "color"), default_aes$colour %||% "black")
  ))
  outline <- as.character(latest_alias_value(gid, c("color", "edgecolor"), color_fallback))
  fill_fallback <- as.character(first_present_value(
    layer_data_values(built_data, "fill"),
    param_value(params, c("fill"), "#1F77B4")
  ))
  stroke_fallback <- suppressWarnings(as.numeric(first_present_value(
    layer_data_values(built_data, "stroke"),
    param_value(params, c("stroke"), default_aes$stroke %||% 0.5)
  )))
  if (length(stroke_fallback) == 0 || !is.finite(stroke_fallback[[1]])) stroke_fallback <- 0.5
  alpha_fallback <- suppressWarnings(as.numeric(first_present_value(
    layer_data_values(built_data, "alpha"),
    param_value(params, c("alpha"), 1)
  )))
  if (length(alpha_fallback) == 0 || !is.finite(alpha_fallback[[1]])) alpha_fallback <- 1

  list(
    color = outline,
    facecolor = latest_string(gid, "facecolor", fill_fallback),
    edgecolor = outline,
    linewidth = latest_numeric(gid, "linewidth", stroke_fallback[[1]]),
    size = latest_numeric(gid, "size", base_size[[1]]),
    size_scale = size_scale,
    sizes = as.list(rendered_sizes),
    marker = marker,
    markerValues = as.list(shapes),
    alpha = latest_numeric(gid, "alpha", alpha_fallback[[1]]),
    fillSupported = fillable,
    sizeMapped = "size" %in% names(effective_mapping),
    shapeMapped = "shape" %in% names(effective_mapping),
    colorMapped = any(c("colour", "color") %in% names(effective_mapping)),
    fillMapped = "fill" %in% names(effective_mapping),
    positionClass = layer_position_class(layer),
    adapterFamily = "point"
  )
}

scaled_point_geom <- function(parent_geom, scale_factor) {
  draw_panel <- local({
    parent <- parent_geom
    factor <- scale_factor
    function(data, panel_params, coord, na.rm = FALSE) {
      data$size <- data$size * factor
      parent$draw_panel(data, panel_params, coord, na.rm = na.rm)
    }
  })
  draw_key <- local({
    parent <- parent_geom
    factor <- scale_factor
    function(data, params, size) {
      data$size <- data$size * factor
      parent$draw_key(data, params, size)
    }
  })
  ggplot2::ggproto(NULL, parent_geom, draw_panel = draw_panel, draw_key = draw_key)
}

apply_point_layer_edits <- function(layer, gid, built_data = NULL) {
  params <- layer$aes_params
  if (is.null(params)) params <- list()

  final_shape <- point_layer_final_shape(layer, gid, built_data)
  final_fillable <- point_layer_final_fillable(layer, gid, built_data)
  if (has_edit(gid, "marker")) {
    params$shape <- final_shape
  }

  if (has_edit(gid, "color") || has_edit(gid, "edgecolor")) {
    params$colour <- as.character(latest_alias_value(
      gid,
      c("color", "edgecolor"),
      params$colour %||% params$color %||% "black"
    ))
  }
  if (has_edit(gid, "facecolor")) {
    if (final_fillable) {
      params$fill <- latest_string(gid, "facecolor", params$fill %||% "#1F77B4")
    } else {
      params$colour <- latest_string(gid, "facecolor", params$colour %||% params$color %||% "black")
    }
  }
  if (has_edit(gid, "linewidth")) {
    params$stroke <- latest_numeric(gid, "linewidth", params$stroke %||% 0.5)
  }
  if (has_edit(gid, "size")) {
    params$size <- latest_numeric(gid, "size", params$size %||% 1.5)
  }
  if (has_edit(gid, "alpha")) {
    params$alpha <- latest_numeric(gid, "alpha", params$alpha %||% 1)
  }

  layer$aes_params <- params
  if (has_edit(gid, "size_scale")) {
    scale_factor <- max(0.01, latest_numeric(gid, "size_scale", 1))
    layer$geom <- scaled_point_geom(layer$geom, scale_factor)
    layer$.scifigure_size_scale <- scale_factor
  }
  layer
}

line_layer_current_props <- function(layer, gid, built_data = NULL, plot_mapping = NULL, protect_mapped_styles = FALSE) {
  params <- layer_params(layer)
  default_aes <- layer$geom$default_aes %||% ggplot2::GeomLine$default_aes
  effective_mapping <- r_effective_layer_mapping(layer, plot_mapping)
  color_fallback <- as.character(first_present_value(
    layer_data_values(built_data, "colour"),
    param_value(params, c("colour", "color"), default_aes$colour %||% "black")
  ))
  linewidth_fallback <- suppressWarnings(as.numeric(first_present_value(
    c(layer_data_values(built_data, "linewidth"), layer_data_values(built_data, "size")),
    param_value(params, c("linewidth", "size"), default_aes$linewidth %||% default_aes$size %||% 1)
  )))
  if (length(linewidth_fallback) == 0 || !is.finite(linewidth_fallback[[1]])) linewidth_fallback <- 1
  rendered_widths <- suppressWarnings(as.numeric(unlist(
    c(layer_data_values(built_data, "linewidth"), layer_data_values(built_data, "size")),
    use.names = FALSE
  )))
  rendered_widths <- rendered_widths[is.finite(rendered_widths)]
  if (length(rendered_widths) == 0) rendered_widths <- linewidth_fallback[[1]]
  linetype_fallback <- as.character(first_present_value(
    layer_data_values(built_data, "linetype"),
    param_value(params, c("linetype"), default_aes$linetype %||% "solid")
  ))
  alpha_fallback <- suppressWarnings(as.numeric(first_present_value(
    layer_data_values(built_data, "alpha"),
    param_value(params, c("alpha"), default_aes$alpha %||% 1)
  )))
  if (length(alpha_fallback) == 0 || !is.finite(alpha_fallback[[1]])) alpha_fallback <- 1
  linewidth_mapped <- "linewidth" %in% names(effective_mapping) || "size" %in% names(effective_mapping)
  linetype_mapped <- "linetype" %in% names(effective_mapping)
  color_mapped <- any(c("colour", "color") %in% names(effective_mapping))
  alpha_mapped <- "alpha" %in% names(effective_mapping)

  list(
    color = if (protect_mapped_styles && color_mapped) color_fallback else latest_string(gid, "color", color_fallback),
    linewidth = if (protect_mapped_styles && linewidth_mapped) linewidth_fallback[[1]] else latest_numeric(gid, "linewidth", linewidth_fallback[[1]]),
    linewidthValues = as.list(rendered_widths),
    linestyle = if (protect_mapped_styles && linetype_mapped) linetype_fallback else latest_string(gid, "linestyle", linetype_fallback),
    alpha = if (protect_mapped_styles && alpha_mapped) alpha_fallback[[1]] else latest_numeric(gid, "alpha", alpha_fallback[[1]]),
    linewidthMapped = linewidth_mapped,
    linetypeMapped = linetype_mapped,
    colorMapped = color_mapped,
    alphaMapped = alpha_mapped,
    positionClass = layer_position_class(layer),
    adapterFamily = "line",
    smoothLayer = identical(geom_class(layer), "GeomSmooth")
  )
}

apply_line_layer_edits <- function(layer, gid) {
  params <- layer$aes_params
  if (is.null(params)) params <- list()

  if (has_edit(gid, "color")) {
    params$colour <- latest_string(gid, "color", params$colour %||% params$color %||% "black")
  }
  if (has_edit(gid, "linewidth")) {
    line_width <- latest_numeric(gid, "linewidth", params$linewidth %||% params$size %||% 1)
    params$linewidth <- line_width
    params$size <- line_width
  }
  if (has_edit(gid, "linestyle")) {
    params$linetype <- latest_string(gid, "linestyle", params$linetype %||% "solid")
  }
  if (has_edit(gid, "alpha")) {
    params$alpha <- latest_numeric(gid, "alpha", params$alpha %||% 1)
  }

  layer$aes_params <- params
  layer
}

segment_curve_data_values <- function(built_data, name) {
  if (is.null(built_data) || !name %in% names(built_data)) return(list())
  values <- built_data[[name]]
  if (is.factor(values)) values <- as.character(values)
  manifest_readonly_parameter(unname(values))
}

segment_curve_arrow_metadata <- function(arrow) {
  if (is.null(arrow) || length(arrow) == 0) return(list())

  length_unit <- arrow$length %||% NULL
  length_value <- suppressWarnings(as.numeric(length_unit))
  if (length(length_value) == 0 || !is.finite(length_value[[1]])) length_value <- NA_real_
  unit_name <- tryCatch(as.character(grid::unitType(length_unit))[[1]], error = function(e) "unknown")
  length_mm <- tryCatch(
    suppressWarnings(as.numeric(grid::convertUnit(length_unit, "mm", valueOnly = TRUE))[[1]]),
    error = function(e) NA_real_
  )
  if (!is.finite(length_mm)) length_mm <- NA_real_

  ends_code <- suppressWarnings(as.integer(arrow$ends %||% NA_integer_))
  if (length(ends_code) == 0 || is.na(ends_code[[1]])) ends_code <- NA_integer_
  type_code <- suppressWarnings(as.integer(arrow$type %||% NA_integer_))
  if (length(type_code) == 0 || is.na(type_code[[1]])) type_code <- NA_integer_

  ends_label <- switch(
    as.character(ends_code[[1]]),
    `1` = "first",
    `2` = "last",
    `3` = "both",
    "unknown"
  )
  type_label <- switch(
    as.character(type_code[[1]]),
    `1` = "open",
    `2` = "closed",
    "unknown"
  )

  list(
    angle = suppressWarnings(as.numeric(arrow$angle %||% 30)[[1]]),
    length = list(
      value = length_value[[1]],
      unit = unit_name,
      mm = length_mm
    ),
    ends = ends_label,
    endsCode = ends_code[[1]],
    type = type_label,
    typeCode = type_code[[1]]
  )
}

segment_curve_layer_current_props <- function(layer, gid, built_data = NULL, plot_mapping = NULL) {
  props <- line_layer_current_props(layer, gid, built_data, plot_mapping, protect_mapped_styles = TRUE)
  geom <- geom_class(layer)
  geom_params <- layer$geom_params %||% list()
  arrow_metadata <- segment_curve_arrow_metadata(geom_params$arrow %||% NULL)
  structure_readonly <- c("x", "y", "xend", "yend", "lineend")

  props$adapterFamily <- if (identical(geom, "GeomCurve")) "curve" else "segment"
  props$x <- segment_curve_data_values(built_data, "x")
  props$y <- segment_curve_data_values(built_data, "y")
  props$xend <- segment_curve_data_values(built_data, "xend")
  props$yend <- segment_curve_data_values(built_data, "yend")
  props$endpointCount <- if (is.null(built_data)) 0L else nrow(built_data)
  props$lineend <- as.character(geom_params$lineend %||% "butt")[[1]]
  props$hasArrow <- length(arrow_metadata) > 0
  props$arrow <- arrow_metadata

  if (identical(geom, "GeomCurve")) {
    props$curvature <- suppressWarnings(as.numeric(geom_params$curvature %||% 0.5)[[1]])
    props$angle <- suppressWarnings(as.numeric(geom_params$angle %||% 90)[[1]])
    props$ncp <- suppressWarnings(as.integer(geom_params$ncp %||% 5)[[1]])
    structure_readonly <- c(structure_readonly, "curvature", "angle", "ncp", "arrow")
  } else {
    props$linejoin <- as.character(geom_params$linejoin %||% "round")[[1]]
    structure_readonly <- c(structure_readonly, "linejoin", "arrow")
  }
  props$structureReadonly <- as.list(structure_readonly)
  props
}

apply_segment_curve_layer_edits <- function(layer, gid, plot_mapping = NULL) {
  params <- layer$aes_params %||% list()
  effective_mapping <- r_effective_layer_mapping(layer, plot_mapping)
  color_mapped <- any(c("colour", "color") %in% names(effective_mapping))
  linewidth_mapped <- "linewidth" %in% names(effective_mapping) || "size" %in% names(effective_mapping)
  linetype_mapped <- "linetype" %in% names(effective_mapping)
  alpha_mapped <- "alpha" %in% names(effective_mapping)

  if (!color_mapped && has_edit(gid, "color")) {
    params$colour <- latest_string(gid, "color", params$colour %||% params$color %||% "black")
  }
  if (!linewidth_mapped && has_edit(gid, "linewidth")) {
    line_width <- latest_numeric(gid, "linewidth", params$linewidth %||% params$size %||% 1)
    params$linewidth <- line_width
    params$size <- line_width
  }
  if (!linetype_mapped && has_edit(gid, "linestyle")) {
    params$linetype <- latest_string(gid, "linestyle", params$linetype %||% "solid")
  }
  if (!alpha_mapped && has_edit(gid, "alpha")) {
    params$alpha <- latest_numeric(gid, "alpha", params$alpha %||% 1)
  }

  layer$aes_params <- params
  layer
}

bar_layer_current_props <- function(layer, gid, built_data = NULL, plot_mapping = NULL) {
  params <- layer_params(layer)
  default_aes <- layer$geom$default_aes %||% ggplot2::GeomCol$default_aes
  effective_mapping <- r_effective_layer_mapping(layer, plot_mapping)
  fill_fallback <- as.character(first_present_value(
    layer_data_values(built_data, "fill"),
    param_value(params, c("fill"), default_aes$fill %||% "#595959")
  ))
  edge_fallback <- as.character(first_present_value(
    layer_data_values(built_data, "colour"),
    param_value(params, c("colour", "color"), default_aes$colour %||% "#000000")
  ))
  linewidth_fallback <- suppressWarnings(as.numeric(first_present_value(
    c(layer_data_values(built_data, "linewidth"), layer_data_values(built_data, "size")),
    param_value(params, c("linewidth", "size"), default_aes$linewidth %||% default_aes$size %||% 0.5)
  )))
  if (length(linewidth_fallback) == 0 || !is.finite(linewidth_fallback[[1]])) linewidth_fallback <- 0.5
  alpha_fallback <- suppressWarnings(as.numeric(first_present_value(
    layer_data_values(built_data, "alpha"),
    param_value(params, c("alpha"), default_aes$alpha %||% 1)
  )))
  if (length(alpha_fallback) == 0 || !is.finite(alpha_fallback[[1]])) alpha_fallback <- 1
  rendered_fills <- as.character(unlist(layer_data_values(built_data, "fill"), use.names = FALSE))
  rendered_fills <- rendered_fills[!is.na(rendered_fills) & nzchar(rendered_fills)]
  if (length(rendered_fills) == 0) rendered_fills <- fill_fallback

  list(
    facecolor = latest_string(gid, "facecolor", fill_fallback),
    edgecolor = latest_string(gid, "edgecolor", edge_fallback),
    linewidth = latest_numeric(gid, "linewidth", linewidth_fallback[[1]]),
    alpha = latest_numeric(gid, "alpha", alpha_fallback[[1]]),
    facecolorValues = as.list(rendered_fills),
    fillMapped = "fill" %in% names(effective_mapping),
    colorMapped = any(c("colour", "color") %in% names(effective_mapping)),
    positionClass = layer_position_class(layer),
    adapterFamily = "bar",
    barCount = if (!is.null(built_data) && !is.null(nrow(built_data))) nrow(built_data) else 0L
  )
}

apply_bar_layer_edits <- function(layer, gid) {
  params <- layer$aes_params
  if (is.null(params)) params <- list()

  if (has_edit(gid, "facecolor")) {
    params$fill <- latest_string(gid, "facecolor", params$fill %||% "#595959")
  }
  if (has_edit(gid, "edgecolor")) {
    params$colour <- latest_string(gid, "edgecolor", params$colour %||% params$color %||% "#000000")
  }
  if (has_edit(gid, "linewidth")) {
    line_width <- latest_numeric(gid, "linewidth", params$linewidth %||% params$size %||% 0.5)
    params$linewidth <- line_width
    params$size <- line_width
  }
  if (has_edit(gid, "alpha")) {
    params$alpha <- latest_numeric(gid, "alpha", params$alpha %||% 1)
  }

  layer$aes_params <- params
  layer
}

finite_numeric_values <- function(values) {
  numeric_values <- suppressWarnings(as.numeric(values %||% numeric()))
  numeric_values[is.finite(numeric_values)]
}

stat_bin_numeric_param <- function(layer, name) {
  value <- finite_numeric_values((layer$stat_params %||% list())[[name]])
  if (length(value) == 0) return(NULL)
  value[[1]]
}

stat_bin_character_param <- function(layer, name) {
  value <- (layer$stat_params %||% list())[[name]]
  if (is.null(value) || length(value) == 0 || is.na(value[[1]])) return(NULL)
  as.character(value[[1]])
}

stat_bin_breaks <- function(built_data = NULL) {
  if (is.null(built_data)) return(numeric())
  values <- c(
    if ("xmin" %in% names(built_data)) built_data$xmin else numeric(),
    if ("xmax" %in% names(built_data)) built_data$xmax else numeric()
  )
  sort(unique(finite_numeric_values(values)))
}

stat_bin_y_stat <- function(layer, plot_mapping = NULL) {
  mapping <- r_effective_layer_mapping(layer, plot_mapping)
  y_label <- tolower(r_expression_label(mapping$y %||% NULL))
  for (candidate in c("ndensity", "density", "ncount", "count")) {
    if (grepl(candidate, y_label, fixed = TRUE)) return(candidate)
  }
  "count"
}

stat_bin_structure_props <- function(layer, built_data = NULL, plot_mapping = NULL) {
  stat_params <- layer$stat_params %||% list()
  counts <- if (!is.null(built_data) && "count" %in% names(built_data)) {
    finite_numeric_values(built_data$count)
  } else {
    numeric()
  }
  density <- if (!is.null(built_data) && "density" %in% names(built_data)) {
    finite_numeric_values(built_data$density)
  } else {
    numeric()
  }
  props <- list(
    statClass = layer_stat_class(layer),
    binCount = if (!is.null(built_data) && !is.null(nrow(built_data))) nrow(built_data) else 0L,
    breaks = as.list(stat_bin_breaks(built_data)),
    counts = as.list(counts),
    density = as.list(density),
    yStat = stat_bin_y_stat(layer, plot_mapping),
    structureReadonly = TRUE
  )
  for (name in c("binwidth", "bins", "boundary", "center")) {
    value <- stat_bin_numeric_param(layer, name)
    if (!is.null(value)) props[[name]] <- value
  }
  for (name in c("closed", "orientation")) {
    value <- stat_bin_character_param(layer, name)
    if (!is.null(value)) props[[name]] <- value
  }
  for (name in c("pad", "drop")) {
    value <- stat_params[[name]]
    if (!is.null(value) && length(value) > 0 && !is.na(value[[1]])) props[[name]] <- isTRUE(value[[1]])
  }
  props
}

step_layer_current_props <- function(layer, gid, built_data = NULL, plot_mapping = NULL) {
  props <- line_layer_current_props(layer, gid, built_data, plot_mapping)
  effective_mapping <- r_effective_layer_mapping(layer, plot_mapping)
  direction <- as.character((layer$geom_params %||% list())$direction %||% "hv")
  props$adapterFamily <- "step"
  props$componentRoles <- as.list(c("step_line"))
  props$stepDirection <- direction
  props$ownerSeriesKey <- r_mapping_signature(effective_mapping)
  props$seriesMode <- "continuous_step"
  props$pointCount <- if (!is.null(built_data) && !is.null(nrow(built_data))) nrow(built_data) else 0L
  props$structureReadonly <- TRUE
  props
}

histogram_layer_current_props <- function(layer, gid, built_data = NULL, plot_mapping = NULL) {
  props <- bar_layer_current_props(layer, gid, built_data, plot_mapping)
  effective_mapping <- r_effective_layer_mapping(layer, plot_mapping)
  props$adapterFamily <- "histogram"
  props$componentRoles <- as.list(c("bins"))
  props$ownerSeriesKey <- r_mapping_signature(effective_mapping)
  props$seriesMode <- "binned_rectangles"
  c(props, stat_bin_structure_props(layer, built_data, plot_mapping))
}

freqpoly_layer_current_props <- function(layer, gid, built_data = NULL, plot_mapping = NULL) {
  props <- line_layer_current_props(layer, gid, built_data, plot_mapping)
  effective_mapping <- r_effective_layer_mapping(layer, plot_mapping)
  props$adapterFamily <- "freqpoly"
  props$componentRoles <- as.list(c("frequency_polygon"))
  props$ownerSeriesKey <- r_mapping_signature(effective_mapping)
  props$seriesMode <- "binned_continuous_line"
  c(props, stat_bin_structure_props(layer, built_data, plot_mapping))
}

errorbar_component_profile <- function(layer) {
  geom <- geom_class(layer)
  switch(
    geom,
    GeomErrorbar = list(
      components = c("interval_line", "caps"),
      hasCaps = TRUE,
      hasPoint = FALSE,
      hasCrossbar = FALSE,
      capParam = "width",
      orientation = "vertical"
    ),
    GeomErrorbarh = list(
      components = c("interval_line", "caps"),
      hasCaps = TRUE,
      hasPoint = FALSE,
      hasCrossbar = FALSE,
      capParam = "height",
      orientation = "horizontal"
    ),
    GeomPointrange = list(
      components = c("interval_line", "point"),
      hasCaps = FALSE,
      hasPoint = TRUE,
      hasCrossbar = FALSE,
      capParam = NULL,
      orientation = "vertical"
    ),
    GeomCrossbar = list(
      components = c("interval_line", "caps", "crossbar"),
      hasCaps = TRUE,
      hasPoint = FALSE,
      hasCrossbar = TRUE,
      capParam = "width",
      orientation = "vertical"
    ),
    list(
      components = c("interval_line"),
      hasCaps = FALSE,
      hasPoint = FALSE,
      hasCrossbar = FALSE,
      capParam = NULL,
      orientation = "vertical"
    )
  )
}

errorbar_cap_extent <- function(layer, built_data = NULL, profile = errorbar_component_profile(layer)) {
  if (!isTRUE(profile$hasCaps) || is.null(profile$capParam)) return(NULL)
  geom_params <- layer$geom_params %||% list()
  explicit <- suppressWarnings(as.numeric(geom_params[[profile$capParam]] %||% NA_real_))
  if (length(explicit) > 0 && is.finite(explicit[[1]])) return(explicit[[1]])

  extent <- if (identical(profile$orientation, "horizontal")) {
    if (!is.null(built_data) && all(c("ymin", "ymax") %in% names(built_data))) {
      suppressWarnings(as.numeric(built_data$ymax - built_data$ymin))
    } else {
      numeric()
    }
  } else if (!is.null(built_data) && all(c("xmin", "xmax") %in% names(built_data))) {
    suppressWarnings(as.numeric(built_data$xmax - built_data$xmin))
  } else {
    numeric()
  }
  extent <- extent[is.finite(extent) & extent >= 0]
  if (length(extent) == 0) 0 else extent[[1]]
}

errorbar_layer_current_props <- function(layer, gid, built_data = NULL, plot_mapping = NULL) {
  params <- layer_params(layer)
  default_aes <- layer$geom$default_aes %||% list()
  effective_mapping <- r_effective_layer_mapping(layer, plot_mapping)
  profile <- errorbar_component_profile(layer)
  color_fallback <- as.character(first_present_value(
    layer_data_values(built_data, "colour"),
    param_value(params, c("colour", "color"), default_aes$colour %||% "black")
  ))
  linewidth_fallback <- suppressWarnings(as.numeric(first_present_value(
    c(layer_data_values(built_data, "linewidth"), layer_data_values(built_data, "size")),
    param_value(params, c("linewidth", "size"), default_aes$linewidth %||% default_aes$size %||% 0.5)
  )))
  if (length(linewidth_fallback) == 0 || !is.finite(linewidth_fallback[[1]])) linewidth_fallback <- 0.5
  final_linewidth <- latest_alias_numeric(gid, c("linewidth", "elinewidth"), linewidth_fallback[[1]])
  linetype_fallback <- as.character(first_present_value(
    layer_data_values(built_data, "linetype"),
    param_value(params, c("linetype"), default_aes$linetype %||% "solid")
  ))
  alpha_fallback <- suppressWarnings(as.numeric(first_present_value(
    layer_data_values(built_data, "alpha"),
    param_value(params, c("alpha"), default_aes$alpha %||% 1)
  )))
  if (length(alpha_fallback) == 0 || !is.finite(alpha_fallback[[1]])) alpha_fallback <- 1
  marker_values <- if (isTRUE(profile$hasPoint)) point_layer_rendered_shapes(layer, built_data) else numeric()
  marker_fallback <- if (length(marker_values) > 0) marker_values[[1]] else default_aes$shape %||% 19
  marker <- point_shape_value(latest_value(gid, "marker", marker_fallback), marker_fallback)
  point_fill_supported <- isTRUE(profile$hasPoint) && point_shapes_are_fillable(list(marker))
  marker_size_fallback <- suppressWarnings(as.numeric(first_present_value(
    layer_data_values(built_data, "size"),
    param_value(params, c("size"), default_aes$size %||% 1.5)
  )))
  if (length(marker_size_fallback) == 0 || !is.finite(marker_size_fallback[[1]])) marker_size_fallback <- 1.5
  fill_fallback <- as.character(first_present_value(
    layer_data_values(built_data, "fill"),
    param_value(params, c("fill"), default_aes$fill %||% "white")
  ))

  props <- list(
    color = latest_string(gid, "color", color_fallback),
    linewidth = final_linewidth,
    elinewidth = final_linewidth,
    linestyle = latest_string(gid, "linestyle", linetype_fallback),
    alpha = latest_numeric(gid, "alpha", alpha_fallback[[1]]),
    colorMapped = any(c("colour", "color") %in% names(effective_mapping)),
    linewidthMapped = "linewidth" %in% names(effective_mapping) || "size" %in% names(effective_mapping),
    componentRoles = as.list(profile$components),
    hasCaps = isTRUE(profile$hasCaps),
    hasPoint = isTRUE(profile$hasPoint),
    hasCrossbar = isTRUE(profile$hasCrossbar),
    orientation = profile$orientation,
    positionClass = layer_position_class(layer),
    intervalCount = if (!is.null(built_data) && !is.null(nrow(built_data))) nrow(built_data) else 0L,
    adapterFamily = "errorbar"
  )
  if (isTRUE(profile$hasCaps)) {
    props$capsize <- latest_numeric(gid, "capsize", errorbar_cap_extent(layer, built_data, profile) %||% 0)
    props$capUnit <- "data"
  }
  if (isTRUE(profile$hasPoint)) {
    props$marker <- marker
    props$markerValues <- as.list(marker_values)
    props$markersize <- latest_numeric(gid, "markersize", marker_size_fallback[[1]])
    props$pointFillSupported <- point_fill_supported
  }
  if (isTRUE(profile$hasCrossbar) || point_fill_supported) {
    props$facecolor <- latest_string(gid, "facecolor", fill_fallback)
    props$fillMapped <- "fill" %in% names(effective_mapping)
  }
  props
}

errorbar_layer_editable <- function(props) {
  editable <- c("color", "elinewidth", "linestyle", "alpha")
  if (isTRUE(props$hasCaps)) editable <- c(editable, "capsize")
  if (isTRUE(props$hasPoint)) editable <- c(editable, "marker", "markersize")
  if (isTRUE(props$hasCrossbar) || isTRUE(props$pointFillSupported)) editable <- c(editable, "facecolor")
  as.list(unique(editable))
}

apply_errorbar_layer_edits <- function(layer, gid) {
  params <- layer$aes_params %||% list()
  profile <- errorbar_component_profile(layer)

  if (has_edit(gid, "color")) {
    params$colour <- latest_string(gid, "color", params$colour %||% params$color %||% "black")
  }
  if (has_edit(gid, "linewidth") || has_edit(gid, "elinewidth")) {
    params$linewidth <- latest_alias_numeric(gid, c("linewidth", "elinewidth"), params$linewidth %||% params$size %||% 0.5)
  }
  if (has_edit(gid, "linestyle")) {
    params$linetype <- latest_string(gid, "linestyle", params$linetype %||% "solid")
  }
  if (has_edit(gid, "alpha")) {
    params$alpha <- latest_numeric(gid, "alpha", params$alpha %||% 1)
  }
  if (isTRUE(profile$hasPoint) && has_edit(gid, "marker")) {
    params$shape <- point_shape_value(latest_value(gid, "marker", params$shape %||% 19), params$shape %||% 19)
  }
  if (isTRUE(profile$hasPoint) && has_edit(gid, "markersize")) {
    params$size <- latest_numeric(gid, "markersize", params$size %||% 1.5)
  }
  if ((isTRUE(profile$hasCrossbar) || isTRUE(profile$hasPoint)) && has_edit(gid, "facecolor")) {
    params$fill <- latest_string(gid, "facecolor", params$fill %||% "white")
  }
  layer$aes_params <- params

  if (isTRUE(profile$hasCaps) && has_edit(gid, "capsize") && !is.null(profile$capParam)) {
    geom_params <- layer$geom_params %||% list()
    geom_params[[profile$capParam]] <- latest_numeric(gid, "capsize", geom_params[[profile$capParam]] %||% 0)
    layer$geom_params <- geom_params
  }
  layer
}

boxplot_outlier_shape_value <- function(value, fallback = 19) {
  if (is.null(value) || length(value) == 0) return(fallback)
  first <- value[[1]]
  if (is.na(first) || tolower(as.character(first)) %in% c("none", "na")) return("none")
  point_shape_value(first, fallback)
}

boxplot_outlier_shape_param <- function(value, fallback = 19) {
  normalized <- boxplot_outlier_shape_value(value, fallback)
  if (identical(normalized, "none")) return(NA)
  normalized
}

boxplot_outlier_count <- function(built_data = NULL) {
  if (is.null(built_data) || !"outliers" %in% names(built_data)) return(0L)
  as.integer(sum(vapply(built_data$outliers, function(values) {
    if (is.null(values)) return(0L)
    length(unlist(values, use.names = FALSE))
  }, integer(1))))
}

boxplot_layer_current_props <- function(layer, gid, built_data = NULL, plot_mapping = NULL) {
  params <- layer_params(layer)
  geom_params <- layer$geom_params %||% list()
  default_aes <- layer$geom$default_aes %||% ggplot2::GeomBoxplot$default_aes
  effective_mapping <- r_effective_layer_mapping(layer, plot_mapping)
  color_fallback <- as.character(first_present_value(
    layer_data_values(built_data, "colour"),
    param_value(params, c("colour", "color"), default_aes$colour %||% "#333333")
  ))
  fill_fallback <- as.character(first_present_value(
    layer_data_values(built_data, "fill"),
    param_value(params, c("fill"), default_aes$fill %||% "white")
  ))
  linewidth_fallback <- suppressWarnings(as.numeric(first_present_value(
    c(layer_data_values(built_data, "linewidth"), layer_data_values(built_data, "size")),
    param_value(params, c("linewidth", "size"), default_aes$linewidth %||% default_aes$size %||% 0.5)
  )))
  if (length(linewidth_fallback) == 0 || !is.finite(linewidth_fallback[[1]])) linewidth_fallback <- 0.5
  alpha_fallback <- suppressWarnings(as.numeric(first_present_value(
    layer_data_values(built_data, "alpha"),
    param_value(params, c("alpha"), default_aes$alpha %||% 1)
  )))
  if (length(alpha_fallback) == 0 || !is.finite(alpha_fallback[[1]])) alpha_fallback <- 1

  outlier_color_fallback <- as.character(first_present_value(
    list(param_value(geom_params, c("outlier.colour", "outlier.color"))),
    color_fallback
  ))
  outlier_fill_fallback <- as.character(first_present_value(
    list(param_value(geom_params, c("outlier.fill"))),
    fill_fallback
  ))
  outlier_shape_fallback <- boxplot_outlier_shape_value(
    param_value(geom_params, c("outlier.shape"), 19),
    19
  )
  outlier_size_fallback <- suppressWarnings(as.numeric(param_value(geom_params, c("outlier.size"), 1.5)))
  if (length(outlier_size_fallback) == 0 || !is.finite(outlier_size_fallback[[1]])) outlier_size_fallback <- 1.5
  outlier_stroke_fallback <- suppressWarnings(as.numeric(param_value(geom_params, c("outlier.stroke"), 0.5)))
  if (length(outlier_stroke_fallback) == 0 || !is.finite(outlier_stroke_fallback[[1]])) outlier_stroke_fallback <- 0.5
  outlier_alpha_fallback <- suppressWarnings(as.numeric(first_present_value(
    list(param_value(geom_params, c("outlier.alpha"))),
    alpha_fallback[[1]]
  )))
  if (length(outlier_alpha_fallback) == 0 || !is.finite(outlier_alpha_fallback[[1]])) outlier_alpha_fallback <- alpha_fallback[[1]]
  final_outlier_shape <- boxplot_outlier_shape_value(
    latest_value(gid, "outlier_shape", outlier_shape_fallback),
    outlier_shape_fallback
  )

  list(
    color = as.character(latest_alias_value(gid, c("color", "median_color"), color_fallback)),
    box_color = latest_string(gid, "box_color", fill_fallback),
    linewidth = latest_numeric(gid, "linewidth", linewidth_fallback[[1]]),
    alpha = latest_numeric(gid, "alpha", alpha_fallback[[1]]),
    outlier_color = latest_string(gid, "outlier_color", outlier_color_fallback),
    outlier_fill = latest_string(gid, "outlier_fill", outlier_fill_fallback),
    outlier_shape = final_outlier_shape,
    outlier_size = latest_numeric(gid, "outlier_size", outlier_size_fallback[[1]]),
    outlier_stroke = latest_numeric(gid, "outlier_stroke", outlier_stroke_fallback[[1]]),
    outlier_alpha = latest_numeric(gid, "outlier_alpha", outlier_alpha_fallback[[1]]),
    outlierFillSupported = !identical(final_outlier_shape, "none") && point_shapes_are_fillable(list(final_outlier_shape)),
    outlierCount = boxplot_outlier_count(built_data),
    fillMapped = "fill" %in% names(effective_mapping),
    colorMapped = any(c("colour", "color") %in% names(effective_mapping)),
    componentRoles = as.list(c("box_body", "median", "whiskers", "staples", "outliers")),
    positionClass = layer_position_class(layer),
    adapterFamily = "boxplot"
  )
}

boxplot_layer_editable <- function(props = list()) {
  editable <- c(
    "color", "linewidth", "alpha", "box_color",
    "outlier_color", "outlier_shape",
    "outlier_size", "outlier_stroke", "outlier_alpha"
  )
  if (isTRUE(props$outlierFillSupported)) editable <- c(editable, "outlier_fill")
  as.list(editable)
}

apply_boxplot_layer_edits <- function(layer, gid) {
  params <- layer$aes_params %||% list()
  geom_params <- layer$geom_params %||% list()

  if (has_edit(gid, "color") || has_edit(gid, "median_color")) {
    params$colour <- as.character(latest_alias_value(
      gid,
      c("color", "median_color"),
      params$colour %||% params$color %||% "#333333"
    ))
  }
  if (has_edit(gid, "box_color")) {
    params$fill <- latest_string(gid, "box_color", params$fill %||% "white")
  }
  if (has_edit(gid, "linewidth")) {
    line_width <- latest_numeric(gid, "linewidth", params$linewidth %||% params$size %||% 0.5)
    params$linewidth <- line_width
    params$size <- line_width
  }
  if (has_edit(gid, "alpha")) {
    params$alpha <- latest_numeric(gid, "alpha", params$alpha %||% 1)
  }
  if (has_edit(gid, "outlier_color")) {
    geom_params[["outlier.colour"]] <- latest_string(gid, "outlier_color", geom_params[["outlier.colour"]] %||% "#333333")
  }
  if (has_edit(gid, "outlier_fill")) {
    geom_params[["outlier.fill"]] <- latest_string(gid, "outlier_fill", geom_params[["outlier.fill"]] %||% "white")
  }
  if (has_edit(gid, "outlier_shape")) {
    geom_params[["outlier.shape"]] <- boxplot_outlier_shape_param(
      latest_value(gid, "outlier_shape", geom_params[["outlier.shape"]] %||% 19),
      geom_params[["outlier.shape"]] %||% 19
    )
  }
  if (has_edit(gid, "outlier_size")) {
    geom_params[["outlier.size"]] <- latest_numeric(gid, "outlier_size", geom_params[["outlier.size"]] %||% 1.5)
  }
  if (has_edit(gid, "outlier_stroke")) {
    geom_params[["outlier.stroke"]] <- latest_numeric(gid, "outlier_stroke", geom_params[["outlier.stroke"]] %||% 0.5)
  }
  if (has_edit(gid, "outlier_alpha")) {
    geom_params[["outlier.alpha"]] <- latest_numeric(gid, "outlier_alpha", geom_params[["outlier.alpha"]] %||% params$alpha %||% 1)
  }

  layer$aes_params <- params
  layer$geom_params <- geom_params
  layer
}

violin_layer_current_props <- function(layer, gid, built_data = NULL, plot_mapping = NULL) {
  params <- layer_params(layer)
  geom_params <- layer$geom_params %||% list()
  default_aes <- layer$geom$default_aes %||% ggplot2::GeomViolin$default_aes
  effective_mapping <- r_effective_layer_mapping(layer, plot_mapping)
  edge_fallback <- as.character(first_present_value(
    layer_data_values(built_data, "colour"),
    param_value(params, c("colour", "color"), default_aes$colour %||% "#333333")
  ))
  fill_fallback <- as.character(first_present_value(
    layer_data_values(built_data, "fill"),
    param_value(params, c("fill"), default_aes$fill %||% "white")
  ))
  linewidth_fallback <- suppressWarnings(as.numeric(first_present_value(
    c(layer_data_values(built_data, "linewidth"), layer_data_values(built_data, "size")),
    param_value(params, c("linewidth", "size"), default_aes$linewidth %||% default_aes$size %||% 0.5)
  )))
  if (length(linewidth_fallback) == 0 || !is.finite(linewidth_fallback[[1]])) linewidth_fallback <- 0.5
  alpha_fallback <- suppressWarnings(as.numeric(first_present_value(
    layer_data_values(built_data, "alpha"),
    param_value(params, c("alpha"), default_aes$alpha %||% 1)
  )))
  if (length(alpha_fallback) == 0 || !is.finite(alpha_fallback[[1]])) alpha_fallback <- 1
  quantiles <- suppressWarnings(as.numeric(unlist(
    geom_params$draw_quantiles %||% geom_params$quantiles %||% numeric(),
    use.names = FALSE
  )))
  quantiles <- quantiles[is.finite(quantiles)]
  component_roles <- c("body")
  if (length(quantiles) > 0) component_roles <- c(component_roles, "quantile_lines")

  list(
    facecolor = latest_string(gid, "facecolor", fill_fallback),
    edgecolor = as.character(latest_alias_value(gid, c("color", "edgecolor"), edge_fallback)),
    linewidth = latest_numeric(gid, "linewidth", linewidth_fallback[[1]]),
    alpha = latest_numeric(gid, "alpha", alpha_fallback[[1]]),
    fillMapped = "fill" %in% names(effective_mapping),
    colorMapped = any(c("colour", "color") %in% names(effective_mapping)),
    componentRoles = as.list(component_roles),
    quantileValues = as.list(quantiles),
    quantileCount = length(quantiles),
    positionClass = layer_position_class(layer),
    adapterFamily = "violin"
  )
}

apply_violin_layer_edits <- function(layer, gid) {
  params <- layer$aes_params %||% list()
  if (has_edit(gid, "color") || has_edit(gid, "edgecolor")) {
    params$colour <- as.character(latest_alias_value(
      gid,
      c("color", "edgecolor"),
      params$colour %||% params$color %||% "#333333"
    ))
  }
  if (has_edit(gid, "facecolor")) {
    params$fill <- latest_string(gid, "facecolor", params$fill %||% "white")
  }
  if (has_edit(gid, "linewidth")) {
    line_width <- latest_numeric(gid, "linewidth", params$linewidth %||% params$size %||% 0.5)
    params$linewidth <- line_width
    params$size <- line_width
  }
  if (has_edit(gid, "alpha")) {
    params$alpha <- latest_numeric(gid, "alpha", params$alpha %||% 1)
  }
  layer$aes_params <- params
  layer
}

ribbon_area_layer_current_props <- function(layer, gid, built_data = NULL, plot_mapping = NULL) {
  params <- layer_params(layer)
  geom <- geom_class(layer)
  default_aes <- layer$geom$default_aes %||% ggplot2::GeomRibbon$default_aes
  effective_mapping <- r_effective_layer_mapping(layer, plot_mapping)
  fill_fallback <- as.character(first_present_value(
    layer_data_values(built_data, "fill"),
    param_value(params, c("fill"), default_aes$fill %||% "#333333")
  ))
  edge_fallback <- as.character(first_present_value(
    layer_data_values(built_data, "colour"),
    param_value(params, c("colour", "color"), default_aes$colour %||% "#000000")
  ))
  linewidth_fallback <- suppressWarnings(as.numeric(first_present_value(
    c(layer_data_values(built_data, "linewidth"), layer_data_values(built_data, "size")),
    param_value(params, c("linewidth", "size"), default_aes$linewidth %||% default_aes$size %||% 0.5)
  )))
  if (length(linewidth_fallback) == 0 || !is.finite(linewidth_fallback[[1]])) linewidth_fallback <- 0.5
  alpha_fallback <- suppressWarnings(as.numeric(first_present_value(
    layer_data_values(built_data, "alpha"),
    param_value(params, c("alpha"), default_aes$alpha %||% 1)
  )))
  if (length(alpha_fallback) == 0 || !is.finite(alpha_fallback[[1]])) alpha_fallback <- 1
  rendered_fills <- as.character(unlist(layer_data_values(built_data, "fill"), use.names = FALSE))
  rendered_fills <- rendered_fills[!is.na(rendered_fills) & nzchar(rendered_fills)]
  if (length(rendered_fills) == 0) rendered_fills <- fill_fallback
  rendered_edges <- as.character(unlist(layer_data_values(built_data, "colour"), use.names = FALSE))
  rendered_edges <- rendered_edges[!is.na(rendered_edges) & nzchar(rendered_edges)]
  if (length(rendered_edges) == 0) rendered_edges <- edge_fallback

  list(
    facecolor = latest_string(gid, "facecolor", fill_fallback),
    edgecolor = latest_string(gid, "edgecolor", edge_fallback),
    linewidth = latest_numeric(gid, "linewidth", linewidth_fallback[[1]]),
    alpha = latest_numeric(gid, "alpha", alpha_fallback[[1]]),
    facecolorValues = as.list(rendered_fills),
    edgecolorValues = as.list(rendered_edges),
    fillMapped = "fill" %in% names(effective_mapping),
    colorMapped = any(c("colour", "color") %in% names(effective_mapping)),
    linewidthMapped = "linewidth" %in% names(effective_mapping) || "size" %in% names(effective_mapping),
    alphaMapped = "alpha" %in% names(effective_mapping),
    componentRoles = as.list(c("body", "boundary_lines")),
    ownerSeriesKey = r_mapping_signature(effective_mapping),
    ownerSeriesMode = "layer",
    positionClass = layer_position_class(layer),
    adapterFamily = if (identical(geom, "GeomArea")) "area" else "ribbon"
  )
}

apply_ribbon_area_layer_edits <- function(layer, gid) {
  params <- layer$aes_params %||% list()
  if (has_edit(gid, "facecolor")) {
    params$fill <- latest_string(gid, "facecolor", params$fill %||% "#333333")
  }
  if (has_edit(gid, "edgecolor")) {
    params$colour <- latest_string(gid, "edgecolor", params$colour %||% params$color %||% "#000000")
  }
  if (has_edit(gid, "linewidth")) {
    line_width <- latest_numeric(gid, "linewidth", params$linewidth %||% params$size %||% 0.5)
    params$linewidth <- line_width
    params$size <- line_width
  }
  if (has_edit(gid, "alpha")) {
    params$alpha <- latest_numeric(gid, "alpha", params$alpha %||% 1)
  }
  layer$aes_params <- params
  layer
}

style_string_or <- function(value, fallback) {
  if (is.null(value) || length(value) == 0 || is.na(value[[1]])) return(fallback)
  text <- as.character(value[[1]])
  if (!nzchar(text) || identical(text, "NA")) fallback else text
}

tile_raster_rect_layer_current_props <- function(layer, gid, built_data = NULL, plot_mapping = NULL) {
  params <- layer_params(layer)
  geom <- geom_class(layer)
  default_aes <- layer$geom$default_aes %||% ggplot2::GeomTile$default_aes
  effective_mapping <- r_effective_layer_mapping(layer, plot_mapping)
  rendered_fills <- as.character(unlist(layer_data_values(built_data, "fill"), use.names = FALSE))
  rendered_fills <- unique(rendered_fills[!is.na(rendered_fills) & nzchar(rendered_fills)])
  fill_fallback <- style_string_or(
    first_present_value(as.list(rendered_fills), param_value(params, c("fill"), default_aes$fill %||% "#595959")),
    "#595959"
  )
  edge_fallback <- style_string_or(
    first_present_value(
      layer_data_values(built_data, "colour"),
      param_value(params, c("colour", "color"), default_aes$colour %||% "#000000")
    ),
    "#000000"
  )
  linewidth_fallback <- suppressWarnings(as.numeric(first_present_value(
    c(layer_data_values(built_data, "linewidth"), layer_data_values(built_data, "size")),
    param_value(params, c("linewidth", "size"), default_aes$linewidth %||% default_aes$size %||% 0.5)
  )))
  if (length(linewidth_fallback) == 0 || !is.finite(linewidth_fallback[[1]])) linewidth_fallback <- 0.5
  alpha_fallback <- suppressWarnings(as.numeric(first_present_value(
    layer_data_values(built_data, "alpha"),
    param_value(params, c("alpha"), default_aes$alpha %||% 1)
  )))
  if (length(alpha_fallback) == 0 || !is.finite(alpha_fallback[[1]])) alpha_fallback <- 1
  fill_mapped <- "fill" %in% names(effective_mapping)
  color_mapped <- any(c("colour", "color") %in% names(effective_mapping))
  edge_supported <- !identical(geom, "GeomRaster")

  list(
    facecolor = if (fill_mapped) fill_fallback else latest_string(gid, "facecolor", fill_fallback),
    edgecolor = if (color_mapped) edge_fallback else latest_string(gid, "edgecolor", edge_fallback),
    linewidth = latest_numeric(gid, "linewidth", linewidth_fallback[[1]]),
    alpha = latest_numeric(gid, "alpha", alpha_fallback[[1]]),
    facecolorValues = as.list(rendered_fills),
    fillMapped = fill_mapped,
    colorMapped = color_mapped,
    alphaMapped = "alpha" %in% names(effective_mapping),
    scaleControlled = fill_mapped,
    edgeStyleSupported = edge_supported,
    componentRoles = if (edge_supported) as.list(c("cells", "cell_edges")) else list("raster_pixels"),
    positionClass = layer_position_class(layer),
    adapterFamily = tolower(sub("^Geom", "", geom))
  )
}

apply_tile_raster_rect_layer_edits <- function(layer, gid, plot_mapping = NULL) {
  params <- layer$aes_params %||% list()
  geom <- geom_class(layer)
  effective_mapping <- r_effective_layer_mapping(layer, plot_mapping)
  fill_mapped <- "fill" %in% names(effective_mapping)
  color_mapped <- any(c("colour", "color") %in% names(effective_mapping))
  if (!fill_mapped && has_edit(gid, "facecolor")) {
    params$fill <- latest_string(gid, "facecolor", params$fill %||% "#595959")
  }
  if (!identical(geom, "GeomRaster") && !color_mapped && has_edit(gid, "edgecolor")) {
    params$colour <- latest_string(gid, "edgecolor", params$colour %||% params$color %||% "#000000")
  }
  if (!identical(geom, "GeomRaster") && has_edit(gid, "linewidth")) {
    line_width <- latest_numeric(gid, "linewidth", params$linewidth %||% params$size %||% 0.5)
    params$linewidth <- line_width
    params$size <- line_width
  }
  if (has_edit(gid, "alpha")) {
    params$alpha <- latest_numeric(gid, "alpha", params$alpha %||% 1)
  }
  layer$aes_params <- params
  layer
}

contour_layer_levels <- function(built_data = NULL) {
  if (is.null(built_data) || !"level" %in% names(built_data)) return(list())
  values <- as.character(built_data$level)
  values <- unique(values[!is.na(values) & nzchar(values)])
  as.list(values)
}

manifest_readonly_parameter <- function(value) {
  if (is.null(value) || length(value) == 0) return(list())
  if (is.function(value) || is.language(value) || is.expression(value)) {
    return(paste(deparse(value, width.cutoff = 500L), collapse = " "))
  }
  if (is.atomic(value)) return(as.list(value))
  if (is.list(value)) return(lapply(value, manifest_readonly_parameter))
  as.character(value)
}

contour_layer_current_props <- function(layer, gid, built_data = NULL, plot_mapping = NULL) {
  params <- layer_params(layer)
  geom <- geom_class(layer)
  filled <- is_contour_filled_adapter_layer(layer)
  default_aes <- layer$geom$default_aes %||% if (filled) ggplot2::GeomContourFilled$default_aes else ggplot2::GeomContour$default_aes
  effective_mapping <- r_effective_layer_mapping(layer, plot_mapping)
  rendered_colors <- as.character(unlist(layer_data_values(built_data, "colour"), use.names = FALSE))
  rendered_colors <- unique(rendered_colors[!is.na(rendered_colors) & nzchar(rendered_colors)])
  rendered_fills <- as.character(unlist(layer_data_values(built_data, "fill"), use.names = FALSE))
  rendered_fills <- unique(rendered_fills[!is.na(rendered_fills) & nzchar(rendered_fills)])
  color_fallback <- style_string_or(
    first_present_value(as.list(rendered_colors), param_value(params, c("colour", "color"), default_aes$colour %||% "#000000")),
    "#000000"
  )
  fill_fallback <- style_string_or(
    first_present_value(as.list(rendered_fills), param_value(params, c("fill"), default_aes$fill %||% "#595959")),
    "#595959"
  )
  linewidth_fallback <- suppressWarnings(as.numeric(first_present_value(
    c(layer_data_values(built_data, "linewidth"), layer_data_values(built_data, "size")),
    param_value(params, c("linewidth", "size"), default_aes$linewidth %||% default_aes$size %||% 0.5)
  )))
  if (length(linewidth_fallback) == 0 || !is.finite(linewidth_fallback[[1]])) linewidth_fallback <- 0.5
  alpha_fallback <- suppressWarnings(as.numeric(first_present_value(
    layer_data_values(built_data, "alpha"),
    param_value(params, c("alpha"), default_aes$alpha %||% 1)
  )))
  if (length(alpha_fallback) == 0 || !is.finite(alpha_fallback[[1]])) alpha_fallback <- 1
  linetype_fallback <- style_string_or(
    first_present_value(layer_data_values(built_data, "linetype"), param_value(params, c("linetype"), default_aes$linetype %||% "solid")),
    "solid"
  )
  fill_mapped <- "fill" %in% names(effective_mapping) || (
    filled && is.null(params$fill) && length(rendered_fills) > 1
  )
  color_mapped <- any(c("colour", "color") %in% names(effective_mapping))
  stat_params <- layer$stat_params %||% list()

  list(
    color = if (color_mapped) color_fallback else latest_string(gid, "color", color_fallback),
    facecolor = if (fill_mapped) fill_fallback else latest_string(gid, "facecolor", fill_fallback),
    edgecolor = if (color_mapped) color_fallback else latest_string(gid, "edgecolor", color_fallback),
    linewidth = latest_numeric(gid, "linewidth", linewidth_fallback[[1]]),
    linestyle = latest_string(gid, "linestyle", linetype_fallback),
    alpha = latest_numeric(gid, "alpha", alpha_fallback[[1]]),
    colorValues = as.list(rendered_colors),
    facecolorValues = as.list(rendered_fills),
    levels = contour_layer_levels(built_data),
    bins = stat_params$bins %||% NULL,
    breaks = manifest_readonly_parameter(stat_params$breaks),
    zMapped = "z" %in% names(effective_mapping),
    fillMapped = fill_mapped,
    colorMapped = color_mapped,
    scaleControlled = if (filled) fill_mapped else color_mapped,
    componentRoles = if (filled) as.list(c("filled_bands", "boundary_lines")) else list("isolines"),
    positionClass = layer_position_class(layer),
    adapterFamily = if (filled) "contourf" else "contour"
  )
}

apply_contour_layer_edits <- function(layer, gid, plot_mapping = NULL) {
  params <- layer$aes_params %||% list()
  filled <- is_contour_filled_adapter_layer(layer)
  effective_mapping <- r_effective_layer_mapping(layer, plot_mapping)
  fill_mapped <- "fill" %in% names(effective_mapping)
  color_mapped <- any(c("colour", "color") %in% names(effective_mapping))
  if (!filled && !color_mapped && has_edit(gid, "color")) {
    params$colour <- latest_string(gid, "color", params$colour %||% params$color %||% "#000000")
  }
  if (filled && !fill_mapped && has_edit(gid, "facecolor")) {
    params$fill <- latest_string(gid, "facecolor", params$fill %||% "#595959")
  }
  if (filled && !color_mapped && has_edit(gid, "edgecolor")) {
    params$colour <- latest_string(gid, "edgecolor", params$colour %||% params$color %||% "#000000")
  }
  if (has_edit(gid, "linewidth")) {
    line_width <- latest_numeric(gid, "linewidth", params$linewidth %||% params$size %||% 0.5)
    params$linewidth <- line_width
    params$size <- line_width
  }
  if (has_edit(gid, "linestyle")) {
    params$linetype <- latest_string(gid, "linestyle", params$linetype %||% "solid")
  }
  if (has_edit(gid, "alpha")) {
    params$alpha <- latest_numeric(gid, "alpha", params$alpha %||% 1)
  }
  layer$aes_params <- params
  layer
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

apply_layer_edits <- function(plot_obj, built_data_by_layer = list()) {
  if (!inherits(plot_obj, "ggplot")) return(plot_obj)
  if (length(plot_obj$layers) == 0) return(plot_obj)

  for (i in seq_along(plot_obj$layers)) {
    gid <- r_layer_manifest_gid(plot_obj$layers[[i]], i)
    built_data <- if (length(built_data_by_layer) >= i) built_data_by_layer[[i]] else NULL
    if (is_point_layer(plot_obj$layers[[i]])) {
      plot_obj$layers[[i]] <- apply_point_layer_edits(plot_obj$layers[[i]], gid, built_data)
      next
    }
    if (is_line_adapter_layer(plot_obj$layers[[i]])) {
      plot_obj$layers[[i]] <- apply_line_layer_edits(plot_obj$layers[[i]], gid)
      next
    }
    if (is_segment_curve_adapter_layer(plot_obj$layers[[i]])) {
      plot_obj$layers[[i]] <- apply_segment_curve_layer_edits(plot_obj$layers[[i]], gid, plot_obj$mapping)
      next
    }
    if (is_bar_adapter_layer(plot_obj$layers[[i]])) {
      plot_obj$layers[[i]] <- apply_bar_layer_edits(plot_obj$layers[[i]], gid)
      next
    }
    if (is_errorbar_adapter_layer(plot_obj$layers[[i]])) {
      plot_obj$layers[[i]] <- apply_errorbar_layer_edits(plot_obj$layers[[i]], gid)
      next
    }
    if (is_boxplot_adapter_layer(plot_obj$layers[[i]])) {
      plot_obj$layers[[i]] <- apply_boxplot_layer_edits(plot_obj$layers[[i]], gid)
      next
    }
    if (is_violin_adapter_layer(plot_obj$layers[[i]])) {
      plot_obj$layers[[i]] <- apply_violin_layer_edits(plot_obj$layers[[i]], gid)
      next
    }
    if (is_ribbon_area_adapter_layer(plot_obj$layers[[i]])) {
      plot_obj$layers[[i]] <- apply_ribbon_area_layer_edits(plot_obj$layers[[i]], gid)
      next
    }
    if (is_tile_raster_rect_adapter_layer(plot_obj$layers[[i]])) {
      plot_obj$layers[[i]] <- apply_tile_raster_rect_layer_edits(plot_obj$layers[[i]], gid, plot_obj$mapping)
      next
    }
    if (is_contour_adapter_layer(plot_obj$layers[[i]])) {
      plot_obj$layers[[i]] <- apply_contour_layer_edits(plot_obj$layers[[i]], gid, plot_obj$mapping)
      next
    }
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
    layer <- plot_obj$layers[[i]]
    geom <- geom_class(layer)
    if (!geom %in% c("GeomText", "GeomLabel")) next
    data <- built$data[[i]]
    if (is.null(data) || nrow(data) == 0) next
    stat_class <- layer_stat_class(layer)
    diagram <- r_layer_diagram_metadata(layer)
    source_kind <- if (!identical(stat_class, "StatIdentity")) {
      "stat"
    } else if (
      identical(layer$inherit.aes, FALSE) &&
      identical(layer$show.legend, FALSE) &&
      !is.null(layer$data) &&
      !inherits(layer$data, "waiver") &&
      nrow(tryCatch(as.data.frame(layer$data), error = function(e) data.frame())) == 1
    ) {
      "annotation"
    } else {
      "data"
    }
    source_data <- layer$data
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
        statClass = stat_class,
        textSource = source_kind,
        dataKey = if (!is.null(stable_keys)) stable_keys[[row_index]] else NULL,
        dataKeySource = stable_key_source,
        data = data[row_index, , drop = FALSE],
        diagram = diagram
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
  if (!is.null(item$diagram)) return(r_diagram_object_gid(item$diagram))
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
  props <- c(
    "text", "fontsize", "fontfamily", "fontweight", "fontstyle", "color",
    "hjust", "vjust", "rotation", "lineheight", "position"
  )
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
  coord_class <- if (length(coord_classes) > 0) as.character(coord_classes[[1]]) else "unknown"
  unsafe_coord <- intersect(coord_classes, c("CoordTrans", "CoordSf", "CoordMap", "CoordQuickmap"))
  if (length(unsafe_coord) > 0) {
    return(list(
      supported = FALSE,
      coordinateClass = as.character(unsafe_coord[[1]]),
      adapter = "projected_or_nonlinear",
      status = "shadow_unsupported",
      reason = paste0("Text dragging disabled for ggplot coordinate system: ", unsafe_coord[[1]])
    ))
  }

  verified_coord_adapters <- c(
    CoordCartesian = "cartesian",
    CoordFixed = "cartesian_fixed",
    CoordFlip = "flip",
    CoordPolar = "polar"
  )
  if (!coord_class %in% names(verified_coord_adapters)) {
    return(list(
      supported = FALSE,
      coordinateClass = coord_class,
      adapter = "third_party_or_unknown",
      status = "shadow_unsupported",
      reason = paste0(
        "Text dragging disabled because ", coord_class,
        " is not a verified SciFigure adapter, even if it inherits a supported ggplot coordinate class."
      )
    ))
  }
  if ("CoordPolar" %in% coord_classes) {
    valid_polar <- length(context$panelParams) > 0 && all(vapply(context$panelParams, function(params) {
      length(params$theta.range %||% numeric()) >= 2 && length(params$r.range %||% numeric()) >= 2
    }, logical(1)))
    if (!valid_polar) return(list(
      supported = FALSE,
      coordinateClass = coord_class,
      adapter = verified_coord_adapters[[coord_class]],
      status = "shadow_unsupported",
      reason = "Text dragging disabled because ggplot polar ranges are unavailable."
    ))
  }

  supported_transforms <- c("identity", "none", "log-10", "log2", "log", "ln")
  for (axis_name in c("x", "y")) {
    transform <- position_scale_transform(context, axis_name)
    if (!transform$name %in% supported_transforms || !is.function(transform$inverse)) {
      return(list(
        supported = FALSE,
        coordinateClass = coord_class,
        adapter = "unsupported_scale_transform",
        status = "shadow_unsupported",
        reason = paste0("Text dragging disabled for transformed ggplot position scale: ", transform$name)
      ))
    }
  }

  list(
    supported = TRUE,
    coordinateClass = coord_class,
    adapter = verified_coord_adapters[[coord_class]],
    status = "supported",
    reason = NULL,
    context = context
  )
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
      !has_edit(gid, "hjust") &&
      !has_edit(gid, "vjust") &&
      !has_edit(gid, "rotation") &&
      !has_edit(gid, "lineheight") &&
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
    if (has_edit(gid, "hjust")) {
      row$hjust <- latest_numeric(gid, "hjust", row$hjust %||% 0.5)
    }
    if (has_edit(gid, "vjust")) {
      row$vjust <- latest_numeric(gid, "vjust", row$vjust %||% 0.5)
    }
    if (has_edit(gid, "rotation")) {
      row$angle <- latest_numeric(gid, "rotation", row$angle %||% 0)
    }
    if (has_edit(gid, "lineheight")) {
      row$lineheight <- latest_numeric(gid, "lineheight", row$lineheight %||% 1.2)
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
    geom_params <- source_layer$geom_params %||% list()
    frozen_identity_key <- source_layer$.scifigure_identity_key %||%
      r_layer_structure_signature(source_layer, plot_obj$mapping)
    layer_data <- inverse_text_position_scales(edited_by_layer[[layer_key]], position_context)
    keep_cols <- intersect(
      c(".scifigure_id", "x", "y", "label", "colour", "color", "fill", "size", "alpha", "family", "fontface", "angle", "hjust", "vjust", "lineheight"),
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
        alpha = layer_data$alpha %||% NA,
        angle = layer_data$angle %||% 0,
        hjust = layer_data$hjust %||% 0.5,
        vjust = layer_data$vjust %||% 0.5,
        lineheight = layer_data$lineheight %||% 1.2,
        parse = isTRUE(geom_params$parse),
        label.padding = geom_params$label.padding %||% grid::unit(0.25, "lines"),
        label.r = geom_params$label.r %||% grid::unit(0.15, "lines"),
        label.size = geom_params$label.size %||% 0.25,
        fill = layer_data$fill %||% source_layer$aes_params$fill %||% "white"
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
        alpha = layer_data$alpha %||% NA,
        angle = layer_data$angle %||% 0,
        hjust = layer_data$hjust %||% 0.5,
        vjust = layer_data$vjust %||% 0.5,
        lineheight = layer_data$lineheight %||% 1.2,
        parse = isTRUE(geom_params$parse),
        check_overlap = isTRUE(geom_params$check_overlap)
      )
    }
    replacement_layer$.scifigure_identity_key <- frozen_identity_key
    replacement_layer$.scifigure_diagram <- source_layer$.scifigure_diagram %||% NULL
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

continuous_scale_breaks <- function(scale_obj, limits) {
  declared <- scale_obj$breaks %||% NULL
  if (!is.null(declared) && !inherits(declared, "waiver") && !is.function(declared)) {
    declared <- unname(declared)
    return(declared[!is.na(declared)])
  }
  breaks <- tryCatch(scale_obj$get_breaks(limits), error = function(e) NULL)
  if (is.null(breaks)) breaks <- tryCatch(scale_obj$get_breaks(), error = function(e) NULL)
  if (is.null(breaks) || inherits(breaks, "waiver")) return(numeric())
  breaks <- unname(breaks)
  breaks[!is.na(breaks)]
}

continuous_scale_labels <- function(scale_obj, breaks) {
  if (length(breaks) == 0) return(character())
  declared <- scale_obj$labels %||% NULL
  if (!is.null(declared) && !inherits(declared, "waiver") && !is.function(declared)) {
    declared <- as.character(unname(declared))
    if (length(declared) == length(breaks)) return(declared)
  }
  labels <- tryCatch(scale_obj$get_labels(breaks), error = function(e) NULL)
  if (is.null(labels) || length(labels) != length(breaks)) labels <- as.character(breaks)
  as.character(labels)
}

find_continuous_colour_scales <- function(plot_obj) {
  built_plot <- tryCatch(ggplot2::ggplot_build(plot_obj)$plot, error = function(e) plot_obj)
  scales <- list()
  kind_ordinals <- list(color = 0L, fill = 0L)
  if (is.null(built_plot$scales) || length(built_plot$scales$scales) == 0) return(scales)
  for (scale_index in seq_along(built_plot$scales$scales)) {
    scale_obj <- built_plot$scales$scales[[scale_index]]
    if (is_continuous_colour_scale(scale_obj)) {
      kind <- scale_kind(scale_obj)
      ordinal <- kind_ordinals[[kind]] %||% 0L
      kind_ordinals[[kind]] <- ordinal + 1L
      scales[[length(scales) + 1]] <- list(
        index = ordinal,
        sourceIndex = scale_index - 1L,
        scale = scale_obj,
        kind = kind
      )
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

r_guide_title_value <- function(scale_obj, plot_obj, kind, mapping_key) {
  guide_obj <- scale_obj$guide %||% NULL
  guide_title <- if (is.list(guide_obj) || is.environment(guide_obj)) guide_obj$title %||% NULL else NULL
  title <- guide_title
  if (is.null(title) || inherits(title, "waiver")) title <- scale_obj$name %||% NULL
  if (is.null(title) || inherits(title, "waiver")) {
    aliases <- if (identical(kind, "color")) c("colour", "color") else kind
    for (alias in aliases) {
      candidate <- plot_obj$labels[[alias]] %||% NULL
      if (!is.null(candidate)) {
        title <- candidate
        break
      }
    }
  }
  if (is.character(title) && length(title) > 0) {
    value <- as.character(title[[1]])
  } else {
    value <- r_expression_label(title)
  }
  if (is.na(value) || !nzchar(value)) value <- mapping_key
  gsub("[\r\n\t ]+", " ", value, perl = TRUE)
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

r_guide_value <- function(guide_obj, name, fallback = NULL) {
  if (is.null(guide_obj) || inherits(guide_obj, "waiver")) return(fallback)
  params <- tryCatch(guide_obj$params, error = function(e) NULL)
  value <- if (!is.null(params)) params[[name]] %||% NULL else NULL
  if (is.null(value)) value <- tryCatch(guide_obj[[name]], error = function(e) NULL)
  value %||% fallback
}

r_guide_visible <- function(scale_obj) {
  guide_obj <- scale_obj$guide %||% NULL
  if (is.character(guide_obj)) return(!any(tolower(guide_obj) == "none"))
  !inherits(guide_obj, "GuideNone")
}

r_normalized_guide_type <- function(scale_obj) {
  if (!r_guide_visible(scale_obj)) return("none")
  guide_obj <- scale_obj$guide %||% NULL
  if (is.character(guide_obj)) {
    guide_names <- tolower(as.character(guide_obj))
    if (any(guide_names %in% c("colorbar", "colourbar"))) return("colorbar")
    if (any(guide_names %in% c("legend"))) return("legend")
  }
  classes <- class(guide_obj)
  if (any(grepl("Colorbar|Colourbar", classes, ignore.case = TRUE))) return("colorbar")
  "legend"
}

r_scale_breaks <- function(scale_obj, limits) {
  breaks <- tryCatch(scale_obj$get_breaks(limits), error = function(e) NULL)
  if (is.null(breaks)) breaks <- tryCatch(scale_obj$get_breaks(), error = function(e) NULL)
  if (is.null(breaks) || inherits(breaks, "waiver")) return(character())
  values <- as.character(breaks)
  values[!is.na(values) & nzchar(values)]
}

r_scale_labels <- function(scale_obj, breaks) {
  if (length(breaks) == 0) return(character())
  labels <- tryCatch(scale_obj$get_labels(breaks), error = function(e) NULL)
  if (is.null(labels) || length(labels) != length(breaks)) labels <- breaks
  labels <- as.character(labels)
  labels[is.na(labels) | !nzchar(labels)] <- breaks[is.na(labels) | !nzchar(labels)]
  labels
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

    raw_limits <- tryCatch(scale_obj$get_limits(), error = function(e) NULL)
    keys <- raw_limits
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
    guide_breaks <- r_scale_breaks(scale_obj, raw_limits)
    guide_labels <- r_scale_labels(scale_obj, guide_breaks)

    ordinal <- kind_ordinals[[kind]] %||% 0L
    kind_ordinals[[kind]] <- ordinal + 1L
    mapping_key <- r_aesthetic_mapping_signature(built_plot, kind)
    scale_key <- r_scale_structure_key(scale_obj, kind, keys, mapping_key)
    guide_title_key <- r_guide_title_signature(scale_obj, built_plot, kind, mapping_key)
    guide_title <- r_guide_title_value(scale_obj, built_plot, kind, mapping_key)
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
      guideTitle = guide_title,
      guideTypeKey = guide_type_key,
      mappingKey = mapping_key,
      scale = scale_obj,
      keys = keys,
      labels = labels,
      colors = colors,
      limits = as.character(raw_limits %||% keys),
      guideBreaks = guide_breaks,
      guideLabels = guide_labels,
      guideVisible = r_guide_visible(scale_obj),
      guideType = r_normalized_guide_type(scale_obj),
      guideReverse = isTRUE(r_guide_value(scale_obj$guide, "reverse", FALSE)),
      guideOrder = suppressWarnings(as.integer(r_guide_value(scale_obj$guide, "order", 0L)))
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

  unique_geoms <- unique(geoms)
  semantic_kind <- if (any(unique_geoms %in% c("GeomLine", "GeomPath", "GeomSmooth", "GeomStep"))) {
    "line"
  } else if (identical(entry$kind, "fill")) {
    distribution_geoms <- unique_geoms[unique_geoms %in% c("GeomBoxplot", "GeomViolin")]
    band_geoms <- unique_geoms[unique_geoms %in% c("GeomRibbon", "GeomArea")]
    if (length(unique_geoms) > 0 && all(unique_geoms == "GeomRibbon")) {
      "ribbon"
    } else if (length(unique_geoms) > 0 && all(unique_geoms == "GeomArea")) {
      "area"
    } else if (length(band_geoms) > 0 && all(unique_geoms %in% c("GeomRibbon", "GeomArea"))) {
      "band"
    } else if (length(unique_geoms) > 0 && all(unique_geoms == "GeomBoxplot")) {
      "boxplot"
    } else if (length(unique_geoms) > 0 && all(unique_geoms == "GeomViolin")) {
      "violin"
    } else if (length(distribution_geoms) > 0 && all(unique_geoms %in% c("GeomBoxplot", "GeomViolin"))) {
      "distribution"
    } else {
      "bar"
    }
  } else {
    "scatter"
  }
  duplicate_color <- sum(vapply(entry$colors, function(value) colors_equal(value, color), logical(1))) > 1
  list(
    layerIds = as.list(unique(layer_ids)),
    subplotIds = as.list(unique(subplot_ids)),
    semanticKind = semantic_kind,
    geomFamilies = as.list(unique_geoms),
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
    entry_group_ids <- character()
    entry_layer_ids <- character()
    entry_subplot_ids <- character()
    for (i in seq_along(entry$keys)) {
      palette_id <- paste0(entry$scaleId, ".", i - 1)
      group_id <- paste0("r.group.", kind, ".", entry$ordinal, ".", i - 1)
      entry_group_ids <- c(entry_group_ids, group_id)
      color <- as.character(entry$colors[[i]])
      label <- as.character(entry$labels[[i]])
      group_key <- as.character(entry$keys[[i]])
      duplicate_group_key <- sum(entry$keys == group_key, na.rm = TRUE) > 1
      usage <- discrete_group_usage(entry, i, catalog$builtData, plot_obj)
      entry_layer_ids <- c(entry_layer_ids, unlist(usage$layerIds, use.names = FALSE))
      entry_subplot_ids <- c(entry_subplot_ids, unlist(usage$subplotIds, use.names = FALSE))
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
        geomFamilies = usage$geomFamilies,
        scaleId = entry$scaleId,
        layerIds = usage$layerIds,
        subplotIds = usage$subplotIds
      )
      objects[[length(objects) + 1]] <- list(
        id = group_id,
        kind = if (usage$semanticKind == "line") "line" else if (kind == "fill") "patch" else "collection",
        label = paste0(label, " (", kind, " scale)"),
        editable = if (duplicate_group_key) list() else list(if (kind == "fill") "facecolor" else "color"),
        currentProps = c(
          if (kind == "fill") list(facecolor = latest_string(group_id, "facecolor", color)) else list(color = latest_string(group_id, "color", color)),
          list(
            aesthetic = kind,
            groupKey = group_key,
            geomFamilies = usage$geomFamilies,
            semanticKind = usage$semanticKind,
            svgSelectable = isTRUE(usage$svgSelectable) && !duplicate_group_key,
            scaleActive = length(usage$layerIds) > 0
          ),
          if (duplicate_group_key) list(
            identityAmbiguous = TRUE,
            unsupportedReason = "Duplicate discrete scale keys do not provide a unique semantic group identity; palette editing is disabled."
          ) else list()
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
    scale_obj <- entry$scale
    objects[[length(objects) + 1]] <- list(
      id = entry$scaleId,
      kind = "container",
      label = paste0("ggplot discrete ", kind, " scale"),
      editable = list(),
      currentProps = list(
        aesthetic = kind,
        keys = as.list(entry$keys),
        limits = as.list(entry$limits),
        breaks = as.list(entry$guideBreaks),
        labels = as.list(entry$guideLabels),
        drop = isTRUE(scale_obj$drop),
        naTranslate = isTRUE(scale_obj$na.translate),
        naValue = as.character(scale_obj$na.value %||% NA_character_),
        guideType = entry$guideType,
        guideVisible = isTRUE(entry$guideVisible),
        guideReverse = isTRUE(entry$guideReverse),
        guideOrder = if (is.na(entry$guideOrder)) 0L else entry$guideOrder,
        structureReadonly = TRUE
      ),
      role = "ggplot_scale_discrete",
      layerIds = as.list(unique(entry_layer_ids)),
      groupIds = as.list(unique(entry_group_ids)),
      subplotIds = as.list(unique(entry_subplot_ids)),
      scaleId = entry$scaleId,
      guideId = "legend.0",
      legendId = "legend.0",
      scaleKey = entry$scaleKey,
      guideKey = entry$guideKey,
      aesthetic = kind,
      source = list(artistClass = "ggplot_scale_discrete", axesIndex = 0, zorder = entry$ordinal)
    )
  }
  list(palettes = palettes, bindings = bindings, groups = groups, objects = objects)
}

discrete_manual_scale_args <- function(entry, values, labels_override = NULL) {
  scale_obj <- entry$scale
  names(values) <- entry$keys
  args <- list(values = values)
  if (!is.null(scale_obj$limits) && !inherits(scale_obj$limits, "waiver")) args$limits <- scale_obj$limits
  if (!is.null(scale_obj$breaks) && !inherits(scale_obj$breaks, "waiver")) args$breaks <- scale_obj$breaks
  if (!is.null(labels_override)) {
    args$labels <- labels_override
  } else if (!is.null(scale_obj$labels) && !inherits(scale_obj$labels, "waiver")) {
    args$labels <- scale_obj$labels
  }
  if (!is.null(scale_obj$name) && length(scale_obj$name) > 0 && !inherits(scale_obj$name, "waiver")) {
    args$name <- scale_obj$name
  }
  if (!is.null(scale_obj$na.value)) args$na.value <- scale_obj$na.value
  if (!is.null(scale_obj$drop)) args$drop <- scale_obj$drop
  if (!is.null(scale_obj$na.translate)) args$na.translate <- scale_obj$na.translate
  if (!is.null(scale_obj$guide) && !inherits(scale_obj$guide, "waiver")) args$guide <- scale_obj$guide
  args
}

discrete_guide_index_map <- function(catalog) {
  guide_keys <- unique(vapply(
    catalog$entries %||% list(),
    function(entry) as.character(entry$guideKey %||% ""),
    character(1)
  ))
  guide_keys <- guide_keys[nzchar(guide_keys)]
  if (length(guide_keys) == 0) return(character())
  order_keys <- vapply(guide_keys, function(guide_key) {
    entries <- Filter(
      function(entry) identical(as.character(entry$guideKey %||% ""), guide_key),
      catalog$entries %||% list()
    )
    paste(
      paste(sort(unique(vapply(entries, function(entry) entry$kind, character(1)))), collapse = "+"),
      paste(sort(unique(vapply(entries, function(entry) entry$scaleKey, character(1)))), collapse = "|"),
      paste(sort(unique(vapply(entries, function(entry) entry$mappingKey, character(1)))), collapse = "|"),
      paste(sort(unique(vapply(entries, function(entry) entry$guideTypeKey, character(1)))), collapse = "|"),
      sep = ":"
    )
  }, character(1))
  guide_keys <- guide_keys[order(order_keys, guide_keys)]
  stats::setNames(paste0("r.guide.legend.", seq_along(guide_keys) - 1L), guide_keys)
}

discrete_guide_title_catalog <- function(plot_obj) {
  catalog <- discrete_scale_catalog(plot_obj)
  guide_ids <- discrete_guide_index_map(catalog)
  titles <- list()
  for (guide_key in names(guide_ids)) {
    entries <- Filter(function(entry) identical(as.character(entry$guideKey), guide_key), catalog$entries)
    if (length(entries) == 0) next
    guide_gid <- unname(guide_ids[[guide_key]])
    title_index <- suppressWarnings(as.integer(sub("^r\\.guide\\.legend\\.", "", guide_gid)))
    if (is.na(title_index)) next
    title <- as.character(entries[[1]]$guideTitle %||% "")
    if (!nzchar(title)) next
    titles[[length(titles) + 1L]] <- list(
      id = paste0("legend_title.", title_index),
      guideId = guide_gid,
      guideKey = guide_key,
      title = title,
      entries = entries
    )
  }
  titles
}

apply_discrete_guide_title_edits <- function(plot_obj) {
  titles <- discrete_guide_title_catalog(plot_obj)
  if (length(titles) == 0) return(plot_obj)

  for (item in titles) {
    if (!has_edit(item$id, "text")) next
    next_title <- latest_string(item$id, "text", item$title)
    labs_args <- list()
    for (entry in item$entries) {
      scale_index <- suppressWarnings(as.integer(entry$scaleIndex))
      if (
        !is.na(scale_index) &&
        scale_index >= 1L &&
        scale_index <= length(plot_obj$scales$scales) &&
        identical(scale_kind(plot_obj$scales$scales[[scale_index]]), entry$kind)
      ) {
        plot_obj$scales$scales[[scale_index]]$name <- next_title
      } else {
        labs_args[[entry$kind]] <- next_title
        if (identical(entry$kind, "color")) labs_args$colour <- next_title
      }
    }
    if (length(labs_args) > 0) {
      plot_obj <- plot_obj + do.call(ggplot2::labs, labs_args)
    }
  }
  plot_obj
}

apply_discrete_scale_edits <- function(plot_obj) {
  catalog <- discrete_scale_catalog(plot_obj)
  if (length(catalog$entries) == 0) return(plot_obj)
  guide_ids <- discrete_guide_index_map(catalog)

  for (entry in catalog$entries) {
    kind <- entry$kind
    values <- entry$colors
    changed <- FALSE
    guide_gid <- unname(guide_ids[[entry$guideKey]] %||% "")
    for (i in seq_along(values)) {
      group_id <- paste0("r.group.", kind, ".", entry$ordinal, ".", i - 1)
      prop <- if (kind == "fill") "facecolor" else "color"
      if (has_edit(group_id, prop)) {
        values[[i]] <- latest_string(group_id, prop, as.character(values[[i]]))
        changed <- TRUE
      }
    }
    guide_visibility_changed <- has_relation_edit("guideKey", entry$guideKey, "visible", guide_gid)
    if (guide_visibility_changed) changed <- TRUE
    if (changed) {
      scale_args <- discrete_manual_scale_args(entry, values)
      if (guide_visibility_changed) {
        scale_args$guide <- if (latest_relation_bool("guideKey", entry$guideKey, "visible", entry$guideVisible, guide_gid)) {
          if (!is.null(entry$scale$guide) && !inherits(entry$scale$guide, "waiver")) entry$scale$guide else "legend"
        } else {
          "none"
        }
      }
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
    source_scale_index <- item$sourceIndex
    scale_gid <- paste0("r.scale.", kind, ".continuous.", scale_index)
    heatmap_gid <- paste0("r.heatmap.", kind, ".", scale_index)
    colorbar_gid <- paste0("r.colorbar.", kind, ".", scale_index)
    limits <- continuous_limits(scale_obj)
    current_vmin <- if (is.finite(limits[[1]])) limits[[1]] else NA_real_
    current_vmax <- if (is.finite(limits[[2]])) limits[[2]] else NA_real_
    current_label <- as.character(scale_obj$name %||% plot_obj$labels[[kind]] %||% kind)
    current_colors <- sample_scale_colors(scale_obj)
    usage <- continuous_scale_layer_usage(
      plot_obj,
      tryCatch(ggplot2::ggplot_build(plot_obj), error = function(e) NULL),
      kind
    )
    layer_gids <- as.character(unlist(usage$layerIds %||% list(), use.names = FALSE))
    contour_gids <- Filter(function(layer_gid) {
      layer_index <- suppressWarnings(as.integer(sub("^r\\.layer\\.", "", layer_gid))) + 1L
      layer_index >= 1L && layer_index <= length(plot_obj$layers) && is_contour_adapter_layer(plot_obj$layers[[layer_index]])
    }, layer_gids)
    scale_edit_gids <- c(scale_gid, heatmap_gid, contour_gids)

    scale_changed <- has_edit_for_any_gid(scale_edit_gids, "cmap") ||
      has_edit_for_any_gid(scale_edit_gids, "vmin") ||
      has_edit_for_any_gid(scale_edit_gids, "vmax") ||
      has_edit(heatmap_gid, "alpha")
    label_changed <- has_edit(colorbar_gid, "label")

    if (scale_changed || label_changed) {
      cmap <- latest_string_for_gids(scale_edit_gids, "cmap", "custom")
      colors <- if (has_edit_for_any_gid(scale_edit_gids, "cmap")) cmap_colors(cmap) else current_colors
      vmin <- latest_numeric_for_gids(scale_edit_gids, "vmin", current_vmin)
      vmax <- latest_numeric_for_gids(scale_edit_gids, "vmax", current_vmax)
      label <- latest_string(colorbar_gid, "label", current_label)
      limits_changed <- has_edit_for_any_gid(scale_edit_gids, "vmin") || has_edit_for_any_gid(scale_edit_gids, "vmax")
      scale_limits <- if (limits_changed && is.finite(vmin) && is.finite(vmax)) {
        c(vmin, vmax)
      } else if (!is.null(scale_obj$limits) && !is.function(scale_obj$limits)) {
        scale_obj$limits
      } else {
        NULL
      }

      scale_args <- list(colours = colors, name = label)
      if (!is.null(scale_limits)) scale_args$limits <- scale_limits
      if (!is.null(scale_obj$breaks) && !inherits(scale_obj$breaks, "waiver")) scale_args$breaks <- scale_obj$breaks
      if (!is.null(scale_obj$labels) && !inherits(scale_obj$labels, "waiver")) scale_args$labels <- scale_obj$labels
      if (!is.null(scale_obj$na.value)) scale_args$na.value <- scale_obj$na.value
      if (!is.null(scale_obj$guide) && !inherits(scale_obj$guide, "waiver")) scale_args$guide <- scale_obj$guide
      transform_name <- as.character(scale_obj$trans$name %||% "")
      if (nzchar(transform_name)) scale_args$trans <- transform_name
      if (!is.null(scale_obj$oob) && is.function(scale_obj$oob)) scale_args$oob <- scale_obj$oob
      if (!is.null(scale_obj$rescaler) && is.function(scale_obj$rescaler)) scale_args$rescaler <- scale_obj$rescaler

      if (kind == "fill") {
        plot_obj <- suppressMessages(plot_obj + do.call(ggplot2::scale_fill_gradientn, scale_args))
      } else {
        plot_obj <- suppressMessages(plot_obj + do.call(ggplot2::scale_color_gradientn, scale_args))
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
      is_visible <- latest_bool(colorbar_gid, "visible", r_guide_visible(scale_obj))
      if (!is_visible) {
        if (kind == "fill") {
          plot_obj <- plot_obj + ggplot2::guides(fill = "none")
        } else {
          plot_obj <- plot_obj + ggplot2::guides(color = "none", colour = "none")
        }
      } else if (!has_bounds_edit) {
        current_guide <- scale_obj$guide %||% NULL
        guide <- if (r_guide_visible(scale_obj) && !is.null(current_guide) && !inherits(current_guide, "waiver")) {
          current_guide
        } else {
          ggplot2::guide_colourbar()
        }
        if (kind == "fill") {
          plot_obj <- plot_obj + ggplot2::guides(fill = guide)
        } else {
          plot_obj <- plot_obj + ggplot2::guides(color = guide, colour = guide)
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
    if (!isTRUE(entry$guideVisible)) next
    changed <- FALSE
    next_labels <- entry$guideLabels
    for (i in seq_along(entry$guideBreaks)) {
      merge_key <- paste(entry$guideKey, entry$guideBreaks[[i]], entry$guideLabels[[i]], sep = ":")
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
      labels_override <- stats::setNames(next_labels, entry$guideBreaks)
      scale_index <- suppressWarnings(as.integer(entry$scaleIndex))
      if (
        !is.na(scale_index) &&
        scale_index >= 1L &&
        scale_index <= length(plot_obj$scales$scales) &&
        identical(scale_kind(plot_obj$scales$scales[[scale_index]]), entry$kind)
      ) {
        plot_obj$scales$scales[[scale_index]]$labels <- labels_override
      } else {
        values <- entry$colors
        scale_args <- discrete_manual_scale_args(entry, values, labels_override)
        if (entry$kind == "fill") {
          plot_obj <- suppressMessages(plot_obj + do.call(ggplot2::scale_fill_manual, scale_args))
        } else {
          plot_obj <- suppressMessages(plot_obj + do.call(ggplot2::scale_colour_manual, scale_args))
        }
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
  legend_title <- latest_string("legend.0", "title", legend_title_from_scale(plot_obj))

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

  if (nzchar(legend_title) && has_edit("legend.0", "title")) {
    if (has_edit("legend.0", "title")) {
      for (scale_index in seq_along(plot_obj$scales$scales)) {
        kind <- scale_kind(plot_obj$scales$scales[[scale_index]])
        if (!is.null(kind) && kind %in% c("color", "fill")) {
          plot_obj$scales$scales[[scale_index]]$name <- legend_title
        }
      }
    }
    plot_obj <- plot_obj + ggplot2::labs(color = legend_title, colour = legend_title, fill = legend_title)
  }

  plot_obj <- apply_discrete_guide_title_edits(plot_obj)

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

  plot_obj <- apply_legend_text_edits(plot_obj)
  plot_obj <- apply_discrete_scale_edits(plot_obj)
  plot_obj <- apply_continuous_scale_edits(plot_obj)
  plot_obj <- apply_text_layer_edits(plot_obj)
  layer_build <- tryCatch(ggplot2::ggplot_build(plot_obj), error = function(e) NULL)
  apply_layer_edits(plot_obj, layer_build$data %||% list())
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
  guide_ids <- discrete_guide_index_map(catalog)
  items <- list()
  for (entry in catalog$entries) {
    if (!isTRUE(entry$guideVisible)) next
    for (i in seq_along(entry$guideBreaks)) {
      key <- as.character(entry$guideBreaks[[i]])
      label <- as.character(entry$guideLabels[[i]])
      key_index <- match(key, entry$keys)
      usage <- if (!is.na(key_index)) {
        discrete_group_usage(entry, key_index, catalog$builtData, plot_obj)
      } else {
        list(layerIds = list(), subplotIds = list())
      }
      group_id <- if (!is.na(key_index)) paste0("r.group.", entry$kind, ".", entry$ordinal, ".", key_index - 1L) else character()
      key_color <- if (!is.na(key_index)) as.character(entry$colors[[key_index]]) else NA_character_
      merge_key <- paste(entry$guideKey, key, label, sep = ":")
      existing_index <- which(vapply(items, function(item) identical(item$mergeKey, merge_key), logical(1)))
      if (length(existing_index) > 0) {
        item_index <- existing_index[[1]]
        items[[item_index]]$aesthetics <- sort(unique(c(items[[item_index]]$aesthetics, entry$kind)))
        items[[item_index]]$scaleIds <- sort(unique(c(items[[item_index]]$scaleIds, entry$scaleId)))
        items[[item_index]]$scaleKeys <- sort(unique(c(items[[item_index]]$scaleKeys, entry$scaleKey)))
        items[[item_index]]$groupIds <- sort(unique(c(items[[item_index]]$groupIds, group_id)))
        items[[item_index]]$layerIds <- sort(unique(c(items[[item_index]]$layerIds, unlist(usage$layerIds, use.names = FALSE))))
        items[[item_index]]$subplotIds <- sort(unique(c(items[[item_index]]$subplotIds, unlist(usage$subplotIds, use.names = FALSE))))
        items[[item_index]]$colors <- c(items[[item_index]]$colors, key_color)
        next
      }
      items[[length(items) + 1]] <- list(
        mergeKey = merge_key,
        guideKey = entry$guideKey,
        guideId = unname(guide_ids[[entry$guideKey]] %||% "legend.0"),
        aesthetics = entry$kind,
        scaleIds = entry$scaleId,
        scaleKeys = entry$scaleKey,
        groupIds = group_id,
        layerIds = as.character(unlist(usage$layerIds, use.names = FALSE)),
        subplotIds = as.character(unlist(usage$subplotIds, use.names = FALSE)),
        colors = key_color,
        dataKey = if (length(entry$kind) == 1) paste("legend", entry$kind, key, sep = ":") else paste("legend", entry$guideKey, key, sep = ":"),
        key = key,
        label = label
      )
    }
  }
  for (i in seq_along(items)) {
    items[[i]]$dataKey <- if (length(items[[i]]$aesthetics) == 1) {
      paste("legend", items[[i]]$aesthetics[[1]], items[[i]]$key, sep = ":")
    } else {
      paste("legend", items[[i]]$guideKey, items[[i]]$key, sep = ":")
    }
  }
  items
}

manifest_discrete_guide_objects <- function(plot_obj) {
  catalog <- discrete_scale_catalog(plot_obj)
  guide_ids <- discrete_guide_index_map(catalog)
  if (length(guide_ids) == 0) return(list())
  items <- legend_item_semantics(plot_obj)
  objects <- list()
  for (guide_key in names(guide_ids)) {
    entries <- Filter(function(entry) identical(as.character(entry$guideKey), guide_key), catalog$entries)
    if (length(entries) == 0) next
    guide_gid <- unname(guide_ids[[guide_key]])
    title_index <- suppressWarnings(as.integer(sub("^r\\.guide\\.legend\\.", "", guide_gid)))
    title_gid <- if (!is.na(title_index)) paste0("legend_title.", title_index) else NULL
    item_indices <- which(vapply(items, function(item) identical(as.character(item$guideKey), guide_key), logical(1)))
    guide_items <- items[item_indices]
    layer_ids <- unique(unlist(lapply(guide_items, function(item) item$layerIds), use.names = FALSE))
    subplot_ids <- unique(unlist(lapply(guide_items, function(item) item$subplotIds), use.names = FALSE))
    legend_text_ids <- paste0("legend_text.0.", item_indices - 1L)
    legend_marker_ids <- paste0("legend_key.0.", item_indices - 1L)
    objects[[length(objects) + 1]] <- list(
      id = guide_gid,
      kind = "guide",
      label = "ggplot discrete guide",
      editable = list("visible"),
      currentProps = list(
        visible = latest_relation_bool(
          "guideKey",
          guide_key,
          "visible",
          any(vapply(entries, function(entry) isTRUE(entry$guideVisible), logical(1))),
          guide_gid
        ),
        guideType = "legend",
        reverse = any(vapply(entries, function(entry) isTRUE(entry$guideReverse), logical(1))),
        order = max(vapply(entries, function(entry) as.integer(entry$guideOrder %||% 0L), integer(1))),
        structureReadonly = TRUE
      ),
      role = "ggplot_semantic_guide",
      parentId = "legend.0",
      legendId = "legend.0",
      guideType = "legend",
      guideKey = guide_key,
      layerIds = as.list(layer_ids),
      subplotIds = as.list(subplot_ids),
      scaleIds = as.list(unique(vapply(entries, function(entry) entry$scaleId, character(1)))),
      groupIds = as.list(unique(unlist(lapply(entries, function(entry) {
        paste0("r.group.", entry$kind, ".", entry$ordinal, ".", seq_along(entry$keys) - 1L)
      }), use.names = FALSE))),
      legendTitleId = title_gid,
      legendTextIds = as.list(legend_text_ids),
      legendMarkerIds = as.list(legend_marker_ids),
      source = list(artistClass = "ggplot_guide_discrete", axesIndex = 0)
    )
  }
  objects
}

legend_item_labels <- function(plot_obj) {
  items <- legend_item_semantics(plot_obj)
  if (length(items) == 0) return(character())
  vapply(items, function(item) item$label, character(1))
}

manifest_legend_text_objects <- function(plot_obj, legend_title, legend_style, legend_guide_key = "ggplot-guide:discrete") {
  objects <- list()
  guide_titles <- discrete_guide_title_catalog(plot_obj)
  if (length(guide_titles) > 0) {
    for (item in guide_titles) {
      title_style <- style_for_gid(item$id, legend_style)
      title <- latest_string(item$id, "text", item$title)
      obj <- manifest_text_object(item$id, "legend_title", title, title_style)
      obj$currentProps$originalText <- item$title
      obj$role <- "legend_title"
      obj$parentId <- "legend.0"
      obj$guideId <- "legend.0"
      obj$guideKey <- item$guideKey
      obj$source <- list(
        artistClass = "ggplot_legend_title",
        axesIndex = 0,
        zorder = suppressWarnings(as.integer(sub("^legend_title\\.", "", item$id)))
      )
      objects[[length(objects) + 1L]] <- obj
    }
  } else if (nzchar(legend_title)) {
    title_style <- style_for_gid("legend_title.0", legend_style)
    obj <- manifest_text_object("legend_title.0", "legend_title", legend_title, title_style)
    obj$role <- "legend_title"
    obj$parentId <- "legend.0"
    obj$guideId <- "legend.0"
    obj$guideKey <- legend_guide_key
    obj$source <- list(artistClass = "ggplot_legend_title", axesIndex = 0)
    objects[[length(objects) + 1L]] <- obj
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
    obj$parentId <- "legend.0"
    obj$guideId <- "legend.0"
    obj$semanticGuideId <- items[[i]]$guideId
    obj$dataKey <- items[[i]]$dataKey
    obj$aesthetic <- paste(items[[i]]$aesthetics, collapse = "+")
    obj$scaleKey <- paste(items[[i]]$scaleKeys, collapse = "|")
    obj$guideKey <- items[[i]]$guideKey
    obj$groupIds <- as.list(items[[i]]$groupIds)
    obj$layerIds <- as.list(items[[i]]$layerIds)
    obj$subplotIds <- as.list(items[[i]]$subplotIds)
    obj$source <- list(artistClass = "ggplot_legend_text", axesIndex = 0, zorder = i)
    objects[[length(objects) + 1]] <- obj
  }
  objects
}

manifest_legend_key_objects <- function(plot_obj) {
  items <- legend_item_semantics(plot_obj)
  if (length(items) == 0) return(list())
  lapply(seq_along(items), function(i) {
    item <- items[[i]]
    list(
      id = paste0("legend_key.0.", i - 1L),
      kind = "component",
      label = paste0("Legend key: ", item$label),
      editable = list(),
      currentProps = list(
        key = item$key,
        label = item$label,
        colors = as.list(item$colors),
        structureReadonly = TRUE
      ),
      role = "legend_key_glyph",
      parentId = "legend.0",
      guideId = item$guideId,
      legendId = "legend.0",
      guideKey = item$guideKey,
      scaleIds = as.list(item$scaleIds),
      scaleKey = paste(item$scaleKeys, collapse = "|"),
      groupIds = as.list(item$groupIds),
      layerIds = as.list(item$layerIds),
      subplotIds = as.list(item$subplotIds),
      dataKey = item$dataKey,
      source = list(artistClass = "ggplot_legend_key_glyph", axesIndex = 0, zorder = i)
    )
  })
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

manifest_layer_object <- function(layer, index, plot_mapping = NULL, built_data = NULL) {
  geom <- geom_class(layer)
  diagram <- r_layer_diagram_metadata(layer)
  adapter_class <- layer_adapter_class(layer)
  gid <- r_layer_manifest_gid(layer, index)
  layer_key <- r_layer_structure_signature(layer, plot_mapping)
  kind <- layer_kind(geom)
  if (kind == "text") diagram <- NULL
  point_adapter <- is_point_layer(layer)
  line_adapter <- is_line_adapter_layer(layer)
  segment_curve_adapter <- is_segment_curve_adapter_layer(layer)
  bar_adapter <- is_bar_adapter_layer(layer)
  step_adapter <- is_step_adapter_layer(layer)
  histogram_adapter <- is_histogram_adapter_layer(layer)
  freqpoly_adapter <- is_freqpoly_adapter_layer(layer)
  errorbar_adapter <- is_errorbar_adapter_layer(layer)
  boxplot_adapter <- is_boxplot_adapter_layer(layer)
  violin_adapter <- is_violin_adapter_layer(layer)
  ribbon_area_adapter <- is_ribbon_area_adapter_layer(layer)
  tile_raster_rect_adapter <- is_tile_raster_rect_adapter_layer(layer)
  contour_adapter <- is_contour_adapter_layer(layer)
  contour_filled_adapter <- is_contour_filled_adapter_layer(layer)
  panel_ids <- if (!is.null(built_data) && "PANEL" %in% names(built_data)) {
    values <- suppressWarnings(as.integer(built_data$PANEL))
    values <- unique(values[is.finite(values) & values >= 1])
    paste0("subplot.", values - 1L)
  } else {
    character()
  }
  props <- if (step_adapter) {
    step_layer_current_props(layer, gid, built_data, plot_mapping)
  } else if (histogram_adapter) {
    histogram_layer_current_props(layer, gid, built_data, plot_mapping)
  } else if (freqpoly_adapter) {
    freqpoly_layer_current_props(layer, gid, built_data, plot_mapping)
  } else if (point_adapter) {
    point_layer_current_props(layer, gid, built_data, plot_mapping)
  } else if (line_adapter) {
    line_layer_current_props(layer, gid, built_data, plot_mapping)
  } else if (segment_curve_adapter) {
    segment_curve_layer_current_props(layer, gid, built_data, plot_mapping)
  } else if (bar_adapter) {
    bar_layer_current_props(layer, gid, built_data, plot_mapping)
  } else if (errorbar_adapter) {
    errorbar_layer_current_props(layer, gid, built_data, plot_mapping)
  } else if (boxplot_adapter) {
    boxplot_layer_current_props(layer, gid, built_data, plot_mapping)
  } else if (violin_adapter) {
    violin_layer_current_props(layer, gid, built_data, plot_mapping)
  } else if (ribbon_area_adapter) {
    ribbon_area_layer_current_props(layer, gid, built_data, plot_mapping)
  } else if (tile_raster_rect_adapter) {
    tile_raster_rect_layer_current_props(layer, gid, built_data, plot_mapping)
  } else if (contour_adapter) {
    contour_layer_current_props(layer, gid, built_data, plot_mapping)
  } else {
    layer_current_props(layer, gid)
  }
  editable <- switch(
    kind,
    text = list("color", "fontsize", "alpha"),
    collection = if (point_adapter) {
      point_editable <- list("color", "size", "size_scale", "marker", "alpha")
      if (isTRUE(props$fillSupported)) {
        point_editable <- c(point_editable, list("facecolor", "edgecolor", "linewidth"))
      }
      point_editable
    } else {
      list("color", "facecolor", "size", "alpha")
    },
    line = list("color", "linewidth", "linestyle", "alpha"),
    patch = list("facecolor", "edgecolor", "linewidth", "alpha"),
    errorbar_container = if (errorbar_adapter) errorbar_layer_editable(props) else list("color", "linewidth", "alpha"),
    boxplot_container = if (boxplot_adapter) boxplot_layer_editable(props) else list("color", "linewidth", "alpha", "box_color"),
    violinplot_container = list("facecolor", "edgecolor", "linewidth", "alpha"),
    contour = if (contour_adapter && !contour_filled_adapter) {
      c(if (isTRUE(props$colorMapped)) list() else list("color"), list("linewidth", "linestyle", "alpha"))
    } else list(),
    contourf = if (contour_filled_adapter) {
      c(
        if (isTRUE(props$fillMapped)) list() else list("facecolor"),
        if (isTRUE(props$colorMapped)) list() else list("edgecolor"),
        list("linewidth", "linestyle", "alpha")
      )
    } else list(),
    unsupported = list(),
    list()
  )
  if (tile_raster_rect_adapter) {
    editable <- c(
      if (isTRUE(props$fillMapped)) list() else list("facecolor"),
      if (isTRUE(props$edgeStyleSupported) && !isTRUE(props$colorMapped)) list("edgecolor") else list(),
      if (isTRUE(props$edgeStyleSupported)) list("linewidth") else list(),
      list("alpha")
    )
  }
  if (segment_curve_adapter) {
    editable <- c(
      if (isTRUE(props$colorMapped)) list() else list("color"),
      if (isTRUE(props$linewidthMapped)) list() else list("linewidth"),
      if (isTRUE(props$linetypeMapped)) list() else list("linestyle"),
      if (isTRUE(props$alphaMapped)) list() else list("alpha")
    )
  }
  if (!is.null(diagram)) {
    if (kind == "text") {
      editable <- list()
    } else if (diagram$semanticRole %in% c("diagram_node", "diagram_group")) {
      editable <- intersect(editable, c("color", "facecolor", "edgecolor", "linewidth", "size", "alpha", "linestyle"))
    } else if (diagram$semanticRole %in% c("diagram_edge", "diagram_arrow")) {
      editable <- intersect(editable, c("color", "linewidth", "linestyle", "alpha"))
    }
  }
  current_props <- switch(
    kind,
    text = list(color = props$color, fontsize = props$size, alpha = props$alpha),
    collection = if (point_adapter) props else list(color = props$color, facecolor = props$facecolor, size = props$size, alpha = props$alpha),
    line = if (line_adapter || segment_curve_adapter) props else list(color = props$color, linewidth = props$linewidth, linestyle = props$linestyle, alpha = props$alpha),
    patch = if (bar_adapter || ribbon_area_adapter || tile_raster_rect_adapter) props else list(facecolor = props$facecolor, edgecolor = props$edgecolor, linewidth = props$linewidth, alpha = props$alpha),
    errorbar_container = if (errorbar_adapter) props else list(color = props$color, linewidth = props$linewidth, alpha = props$alpha),
    boxplot_container = if (boxplot_adapter) props else list(color = props$color, linewidth = props$linewidth, alpha = props$alpha, box_color = latest_string(gid, "box_color", props$facecolor)),
    violinplot_container = if (violin_adapter) props else list(facecolor = props$facecolor, edgecolor = props$edgecolor, linewidth = props$linewidth, alpha = props$alpha),
    contour = props,
    contourf = props,
    unsupported = list(unsupportedReason = paste0("No stable SciFigure write-back adapter for ggplot geom class ", geom, ".")),
    list()
  )
  if (!is.null(diagram)) {
    current_props$diagramId <- diagram$diagramId
    current_props$diagramType <- diagram$diagramType
    current_props$diagramObjectId <- diagram$diagramObjectId
    current_props$structureReadonly <- as.list(unique(c(
      unlist(current_props$structureReadonly %||% list(), use.names = FALSE),
      "diagram_id", "diagram_type", "diagram_object_id",
      if (!is.null(diagram$nodeId)) "node_id" else character(),
      if (!is.null(diagram$edgeId)) c("edge_id", "source_node_id", "target_node_id") else character()
    )))
    if (isTRUE(diagram$layoutEditable) && diagram$semanticRole == "diagram_node") {
      current_props$layoutEditMode <- "explicit_semantic_layout"
    }
  }
  arrow_id <- if (segment_curve_adapter && isTRUE(current_props$hasArrow)) {
    paste0("r.arrow.", index - 1)
  } else {
    NULL
  }
  diagram_fields <- if (!is.null(diagram)) {
    list(
      diagramId = diagram$diagramId,
      diagramType = diagram$diagramType,
      diagramObjectId = diagram$diagramObjectId,
      nodeId = diagram$nodeId,
      edgeId = diagram$edgeId,
      sourceNodeId = diagram$sourceNodeId,
      targetNodeId = diagram$targetNodeId
    )
  } else {
    list()
  }
  c(list(
    id = gid,
    kind = kind,
    label = layer_label(adapter_class, index),
    editable = editable,
    currentProps = current_props,
    role = if (!is.null(diagram) && kind != "text") diagram$semanticRole else paste0("ggplot_", geom),
    arrowId = if (is.null(diagram)) arrow_id else NULL,
    children = if (!is.null(diagram)) list() else if (!is.null(arrow_id)) list(arrow_id) else list(),
    layerKey = layer_key,
    subplotIds = as.list(panel_ids),
    source = c(list(
      artistClass = geom,
      adapterClass = adapter_class,
      positionClass = layer_position_class(layer),
      axesIndex = 0,
      zorder = index,
      layerSignature = layer_key
    ), if (!is.null(diagram)) list(callName = "SciFigure.semantic_gid", diagram = diagram) else list()),
    semanticCoverage = if (!is.null(diagram)) list(
      family = "diagram",
      status = "dedicated",
      attribution = "source.explicit_semantic_gid"
    ) else NULL
  ), diagram_fields)
}

manifest_segment_curve_arrow_objects <- function(plot_obj, built_data = list()) {
  if (!inherits(plot_obj, "ggplot") || length(plot_obj$layers) == 0) return(list())
  objects <- list()
  for (index in seq_along(plot_obj$layers)) {
    layer <- plot_obj$layers[[index]]
    if (!is_segment_curve_adapter_layer(layer)) next
    if (!is.null(r_layer_diagram_metadata(layer))) next
    arrow <- segment_curve_arrow_metadata((layer$geom_params %||% list())$arrow %||% NULL)
    if (length(arrow) == 0) next
    layer_id <- paste0("r.layer.", index - 1)
    arrow_id <- paste0("r.arrow.", index - 1)
    geom <- geom_class(layer)
    data <- if (length(built_data) >= index) built_data[[index]] else NULL
    panel_ids <- if (!is.null(data) && "PANEL" %in% names(data)) {
      values <- suppressWarnings(as.integer(data$PANEL))
      values <- unique(values[is.finite(values) & values >= 1])
      paste0("subplot.", values - 1L)
    } else {
      character()
    }
    objects[[length(objects) + 1]] <- list(
      id = arrow_id,
      kind = "patch",
      label = if (identical(geom, "GeomCurve")) "ggplot curve arrow" else "ggplot segment arrow",
      editable = list(),
      currentProps = c(
        arrow,
        list(
          adapterFamily = if (identical(geom, "GeomCurve")) "curve_arrow" else "segment_arrow",
          parentOwned = TRUE,
          structureReadonly = list("angle", "length", "ends", "type")
        )
      ),
      role = if (identical(geom, "GeomCurve")) "ggplot_curve_arrow" else "ggplot_segment_arrow",
      parentId = layer_id,
      layerId = layer_id,
      layerKey = r_layer_structure_signature(layer, plot_obj$mapping),
      subplotIds = as.list(panel_ids),
      source = list(
        artistClass = paste0(geom, "Arrow"),
        adapterClass = geom,
        axesIndex = 0,
        zorder = index
      )
    )
  }
  objects
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

r_unit_to_pt <- function(value, fallback = NA_real_) {
  if (is.null(value) || length(value) == 0) return(fallback)
  converted <- tryCatch(
    suppressWarnings(as.numeric(grid::convertUnit(value, "pt", valueOnly = TRUE))[[1]]),
    error = function(e) NA_real_
  )
  if (is.finite(converted)) converted else fallback
}

r_facet_layout_semantics <- function(plot_obj, layout) {
  params <- plot_obj$facet$params %||% list()
  free <- params$free %||% list()
  free_x <- isTRUE(free$x)
  free_y <- isTRUE(free$y)
  facet_scales <- if (free_x && free_y) {
    "free"
  } else if (free_x) {
    "free_x"
  } else if (free_y) {
    "free_y"
  } else {
    "fixed"
  }

  strip_position <- as.character(params$strip.position %||% "")
  if (!nzchar(strip_position)) {
    switch_value <- as.character(params$switch %||% "")
    strip_position <- if (switch_value %in% c("x", "both")) "bottom" else "top"
  }

  combined_theme <- tryCatch(ggplot2::theme_get() + plot_obj$theme, error = function(e) plot_obj$theme)
  theme_value <- function(name) {
    tryCatch(ggplot2::calc_element(name, combined_theme), error = function(e) NULL)
  }
  spacing <- theme_value("panel.spacing")
  spacing_x <- theme_value("panel.spacing.x") %||% spacing
  spacing_y <- theme_value("panel.spacing.y") %||% spacing

  structural_cols <- c("PANEL", "ROW", "COL", "SCALE_X", "SCALE_Y", "COORD")
  facet_vars <- setdiff(names(layout), structural_cols)
  layout_key <- paste(c("facet-layout", facet_vars), collapse = ":")

  list(
    freeX = free_x,
    freeY = free_y,
    facetScales = facet_scales,
    stripPosition = strip_position,
    panelSpacingXPt = r_unit_to_pt(spacing_x),
    panelSpacingYPt = r_unit_to_pt(spacing_y),
    facetKey = layout_key
  )
}

manifest_facet_layout_object <- function(plot_obj) {
  if (!is_faceted_plot(plot_obj)) return(NULL)
  built <- tryCatch(ggplot2::ggplot_build(plot_obj), error = function(e) NULL)
  layout <- built$layout$layout %||% NULL
  if (is.null(layout) || nrow(layout) == 0) return(NULL)
  semantics <- r_facet_layout_semantics(plot_obj, layout)
  subplot_ids <- paste0("subplot.", as.integer(layout$PANEL) - 1L)
  list(
    id = "r.facet.layout.0",
    kind = "container",
    label = "ggplot facet layout",
    editable = list("aspect"),
    currentProps = list(
      aspect = subplot_aspect_value(),
      freeX = semantics$freeX,
      freeY = semantics$freeY,
      facetScales = semantics$facetScales,
      stripPosition = semantics$stripPosition,
      panelSpacingXPt = semantics$panelSpacingXPt,
      panelSpacingYPt = semantics$panelSpacingYPt,
      physicalPanelBounds = "readonly",
      unsupportedProps = list("left", "bottom", "width", "height"),
      unsupportedReason = "ggplot facet geometry is owned by the shared gtable layout and has no independent Matplotlib-style panel bounds."
    ),
    role = "ggplot_facet_layout",
    facetKey = semantics$facetKey,
    subplotIds = as.list(subplot_ids),
    source = list(artistClass = "ggplot_facet_layout", axesIndex = 0)
  )
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
  semantics <- r_facet_layout_semantics(plot_obj, layout)

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
      editable = list(),
      currentProps = list(
        subplotIndex = panel - 1,
        panel = panel,
        row = row_index,
        col = col_index,
        label = label,
        aspect = aspect,
        freeX = semantics$freeX,
        freeY = semantics$freeY,
        facetScales = semantics$facetScales,
        unsupportedProps = list("left", "bottom", "width", "height"),
        unsupportedReason = "ggplot facet panels use shared gtable layout; independent panel bounds are not equivalent to Matplotlib axes bounds."
      ),
      role = "ggplot_facet_panel",
      parentId = "r.facet.layout.0",
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
    parentId = "r.facet.layout.0",
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
    diagram <- item$diagram %||% NULL
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
    parse_enabled <- isTRUE((plot_obj$layers[[item$layerIndex]]$geom_params %||% list())$parse)
    raw_position <- inverse_text_position_scales(data.frame(x = data$x, y = data$y), position_context)
    editable <- if (identical(item$textSource, "stat")) {
      list()
    } else {
      list(
        "text", "fontsize", "fontfamily", "fontweight", "fontstyle", "color",
        "hjust", "vjust", "rotation", "lineheight"
      )
    }
    if (!is.null(diagram)) editable <- setdiff(editable, "text")
    current_props <- list(
      text = latest_string(gid, "text", as.character(data$label %||% "")),
      fontsize = latest_numeric(gid, "fontsize", as.numeric(data$size %||% default_label$fontsize)),
      fontfamily = latest_string(gid, "fontfamily", as.character(data$family %||% "")),
      fontweight = latest_string(gid, "fontweight", face$fontweight),
      fontstyle = latest_string(gid, "fontstyle", face$fontstyle),
      color = latest_string(gid, "color", as.character(data$colour %||% "black")),
      hjust = latest_numeric(gid, "hjust", as.numeric(data$hjust %||% 0.5)),
      vjust = latest_numeric(gid, "vjust", as.numeric(data$vjust %||% 0.5)),
      rotation = latest_numeric(gid, "rotation", as.numeric(data$angle %||% 0)),
      lineheight = latest_numeric(gid, "lineheight", as.numeric(data$lineheight %||% 1.2)),
      parse = parse_enabled,
      textSyntax = if (parse_enabled) "plotmath" else "plain",
      textSource = item$textSource,
      statClass = item$statClass,
      data_x = as.numeric(raw_position$x),
      data_y = as.numeric(raw_position$y),
      dataKey = item$dataKey,
      positionCoordinateClass = position_support$coordinateClass,
      positionAdapter = position_support$adapter,
      identityStability = if (identical(item$textSource, "stat")) "readonly" else if (!is.null(item$dataKey)) "stable" else "unsupported",
      identityStabilityReason = if (!is.null(item$dataKey)) {
        if (identical(item$textSource, "stat")) {
          "Stat-generated text is identified separately but remains readonly because replay would replace the statistical layer with frozen labels."
        } else if (identical(item$dataKeySource, "source")) {
          "Stable data key supplied by the text layer source data."
        } else {
          "Stable semantic key derived from the original text label, coordinates, and panel."
        }
      } else {
        "No unique source or semantic row key is available; replay is disabled to prevent ordinal remapping."
      }
    )
    if (!identical(item$textSource, "stat") && isTRUE(position_support$supported)) {
      editable <- c(editable, list("position"))
      current_props$positionAdapterStatus <- "supported"
      current_props$x <- pos$x
      current_props$y <- pos$y
      current_props$coord_system <- "axes"
      current_props$position <- list(
        x = pos$x,
        y = pos$y,
        coord_system = "axes"
      )
    } else {
      current_props$positionEditable <- FALSE
      current_props$positionAdapterStatus <- if (identical(item$textSource, "stat")) "readonly_stat" else position_support$status
      current_props$positionUnsupportedReason <- if (identical(item$textSource, "stat")) {
        "Stat-generated text position is readonly because moving it would freeze statistical output into annotation data."
      } else {
        position_support$reason
      }
    }
    if (!is.null(diagram)) {
      protected_props <- switch(
        diagram$semanticRole,
        diagram_node_label = c("text", "node_id"),
        diagram_coefficient_label = c(
          "text", "edge_id", "coefficient", "value", "p_value", "pvalue",
          "significance", "confidence_interval", "ci_low", "ci_high"
        ),
        diagram_fit_annotation = c(
          "text", "fit", "fit_indices", "cfi", "tli", "rmsea", "srmr",
          "aic", "bic", "chi_square", "p_value", "pvalue"
        ),
        "text"
      )
      current_props$structureReadonly <- as.list(protected_props)
      current_props$diagramId <- diagram$diagramId
      current_props$diagramType <- diagram$diagramType
      current_props$diagramObjectId <- diagram$diagramObjectId
    }
    diagram_fields <- if (!is.null(diagram)) {
      list(
        diagramId = diagram$diagramId,
        diagramType = diagram$diagramType,
        diagramObjectId = diagram$diagramObjectId,
        nodeId = diagram$nodeId,
        edgeId = diagram$edgeId,
        sourceNodeId = diagram$sourceNodeId,
        targetNodeId = diagram$targetNodeId
      )
    } else {
      list()
    }
    c(list(
      id = manifest_gid,
      kind = "text",
      label = paste0("ggplot text ", item$layerIndex - 1, ".", item$rowIndex - 1),
      editable = editable,
      currentProps = current_props,
      role = if (!is.null(diagram)) diagram$semanticRole else paste0("ggplot_text_", item$textSource),
      annotationId = if (identical(item$textSource, "annotation")) manifest_gid else NULL,
      textSource = item$textSource,
      statClass = item$statClass,
      subplotId = paste0("subplot.", panel - 1),
      facetKey = panel_keys[[as.character(panel)]] %||% "root",
      layerId = paste0("r.layer.", item$layerIndex - 1),
      layerKey = layer_key,
      groupKey = as.character(data$group %||% item$rowIndex),
      dataKey = item$dataKey,
      aesthetic = "label",
      source = c(
        list(artistClass = item$geom, axesIndex = panel - 1, zorder = item$layerIndex),
        if (!is.null(diagram)) list(callName = "SciFigure.semantic_gid", diagram = diagram) else list()
      ),
      semanticCoverage = if (!is.null(diagram)) list(
        family = "diagram",
        status = "dedicated",
        attribution = "source.explicit_semantic_gid"
      ) else NULL
    ), diagram_fields)
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
    source_scale_index <- item$sourceIndex
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
    layer_ids <- as.character(unlist(usage$layerIds, use.names = FALSE))
    contour_layer_ids <- Filter(function(layer_id) {
      layer_index <- suppressWarnings(as.integer(sub("^r\\.layer\\.", "", layer_id))) + 1L
      layer_index >= 1L && layer_index <= length(plot_obj$layers) && is_contour_adapter_layer(plot_obj$layers[[layer_index]])
    }, layer_ids)
    scale_edit_gids <- c(scale_id, heatmap_gid, contour_layer_ids)
    scale_breaks <- continuous_scale_breaks(scale_obj, scale_obj$limits %||% limits)
    scale_labels <- continuous_scale_labels(scale_obj, scale_breaks)
    transform_name <- as.character(scale_obj$trans$name %||% "identity")
    guide_visible <- latest_bool(colorbar_gid, "visible", r_guide_visible(scale_obj))
    guide_type <- r_normalized_guide_type(scale_obj)
    if (isTRUE(guide_visible) && identical(guide_type, "none")) guide_type <- "colorbar"

    objects[[length(objects) + 1]] <- list(
      id = scale_id,
      kind = "container",
      label = paste0("ggplot continuous ", kind, " scale"),
      editable = list("cmap", "vmin", "vmax"),
      currentProps = list(
        aesthetic = kind,
        cmap = latest_string_for_gids(scale_edit_gids, "cmap", "custom"),
        vmin = latest_numeric_for_gids(scale_edit_gids, "vmin", current_vmin),
        vmax = latest_numeric_for_gids(scale_edit_gids, "vmax", current_vmax),
        breaks = as.list(scale_breaks),
        labels = as.list(scale_labels),
        transform = transform_name,
        naValue = as.character(scale_obj$na.value %||% NA_character_),
        guideType = guide_type,
        guideVisible = guide_visible,
        guideReverse = isTRUE(r_guide_value(scale_obj$guide, "reverse", FALSE)),
        guideOrder = suppressWarnings(as.integer(r_guide_value(scale_obj$guide, "order", 0L))),
        sourceScaleIndex = source_scale_index,
        scaleClass = paste(class(scale_obj), collapse = "/"),
        structureReadonly = TRUE
      ),
      role = "ggplot_scale_continuous",
      layerIds = usage$layerIds,
      subplotIds = subplot_ids,
      scaleId = scale_id,
      guideId = colorbar_gid,
      scaleKey = scale_key,
      guideKey = guide_key,
      aesthetic = kind,
      source = list(artistClass = "ggplot_scale_continuous", axesIndex = 0, zorder = scale_index)
    )

    if (has_heatmap) {
      objects[[length(objects) + 1]] <- list(
        id = heatmap_gid,
        kind = "heatmap",
        label = paste0("ggplot heatmap ", kind, " scale"),
        editable = list("cmap", "vmin", "vmax", "alpha"),
        currentProps = list(
          cmap = latest_string_for_gids(scale_edit_gids, "cmap", "custom"),
          vmin = latest_numeric_for_gids(scale_edit_gids, "vmin", current_vmin),
          vmax = latest_numeric_for_gids(scale_edit_gids, "vmax", current_vmax),
          alpha = latest_numeric(heatmap_gid, "alpha", 1),
          scale = kind,
          sourceScaleIndex = source_scale_index
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
    colorbar_bounds_proven <- length(continuous_scales) == 1L
    mappable_ids <- if (has_heatmap) list(heatmap_gid) else usage$layerIds
    mappable_id <- mappable_ids[[1]]

    objects[[length(objects) + 1]] <- list(
      id = colorbar_gid,
      kind = "colorbar",
      label = paste0("ggplot colorbar ", label),
      editable = c(
        list("label", "tick_fontsize", "visible"),
        if (colorbar_bounds_proven) list("left", "bottom", "width", "height") else list()
      ),
      currentProps = list(
        label = latest_string(colorbar_gid, "label", label),
        tick_fontsize = latest_numeric(colorbar_gid, "tick_fontsize", default_legend$fontsize),
        visible = guide_visible,
        left = latest_numeric(colorbar_gid, "left", colorbar_bounds$left),
        bottom = latest_numeric(colorbar_gid, "bottom", colorbar_bounds$bottom),
        width = latest_numeric(colorbar_gid, "width", colorbar_bounds$width),
        height = latest_numeric(colorbar_gid, "height", colorbar_bounds$height),
        vmin = latest_numeric_for_gids(scale_edit_gids, "vmin", current_vmin),
        vmax = latest_numeric_for_gids(scale_edit_gids, "vmax", current_vmax),
        cmap = latest_string_for_gids(scale_edit_gids, "cmap", "custom"),
        sourceScaleIndex = source_scale_index,
        physicalBounds = if (colorbar_bounds_proven) "single-guide" else "readonly",
        unsupportedProps = if (colorbar_bounds_proven) list() else list("left", "bottom", "width", "height"),
        unsupportedReason = if (colorbar_bounds_proven) NULL else "Multiple ggplot continuous guides do not expose independently provable physical bounds."
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

link_family8_continuous_relations <- function(objects, continuous_objects) {
  if (length(objects) == 0 || length(continuous_objects) == 0) return(objects)
  object_index_by_id <- setNames(seq_along(objects), vapply(
    objects,
    function(object) as.character(object$id %||% ""),
    character(1)
  ))
  continuous_ids <- vapply(
    continuous_objects,
    function(object) as.character(object$id %||% ""),
    character(1)
  )
  for (colorbar in continuous_objects) {
    if (!identical(as.character(colorbar$kind %||% ""), "colorbar")) next
    colorbar_id <- as.character(colorbar$id %||% "")
    layer_ids <- as.character(unlist(colorbar$layerIds %||% list(), use.names = FALSE))
    if (!nzchar(colorbar_id) || length(layer_ids) == 0) next
    heatmap_id <- as.character(colorbar$mappableId %||% "")
    has_heatmap_object <- nzchar(heatmap_id) && heatmap_id %in% continuous_ids && startsWith(heatmap_id, "r.heatmap.")
    scale_gids <- c(
      if (has_heatmap_object) heatmap_id else character(),
      layer_ids
    )
    for (layer_id in layer_ids) {
      layer_index <- if (layer_id %in% names(object_index_by_id)) object_index_by_id[[layer_id]] else NULL
      if (is.null(layer_index)) next
      object <- objects[[layer_index]]
      geom <- as.character(object$source$artistClass %||% "")
      object$scaleId <- colorbar$scaleId
      object$guideId <- colorbar_id
      object$colorbarId <- colorbar_id
      object$mappableId <- if (has_heatmap_object) heatmap_id else layer_id
      object$scaleKey <- colorbar$scaleKey
      object$guideKey <- colorbar$guideKey
      object$aesthetic <- colorbar$aesthetic
      object$currentProps$scaleControlled <- TRUE
      if (geom %in% c("GeomContour", "GeomContourFilled")) {
        object$currentProps$cmap <- latest_string_for_gids(scale_gids, "cmap", object$currentProps$cmap %||% "custom")
        object$currentProps$vmin <- latest_numeric_for_gids(scale_gids, "vmin", object$currentProps$vmin %||% NA_real_)
        object$currentProps$vmax <- latest_numeric_for_gids(scale_gids, "vmax", object$currentProps$vmax %||% NA_real_)
        object$editable <- unique(c(object$editable %||% list(), "cmap", "vmin", "vmax"))
      }
      objects[[layer_index]] <- object
    }

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
      x_anchor <- "middle"
      y_position <- as.character(params$y$position %||% "left")
      y_anchor <- if (identical(y_position, "right")) "start" else "end"
      
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
          anchor_match <- regmatches(open_tag, regexec("\\btext-anchor\\s*=\\s*['\"]([^'\"]+)['\"]", open_tag, perl = TRUE))[[1]]
          if (length(anchor_match) < 2 || !identical(anchor_match[[2]], x_anchor)) next
          
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
          anchor_match <- regmatches(open_tag, regexec("\\btext-anchor\\s*=\\s*['\"]([^'\"]+)['\"]", open_tag, perl = TRUE))[[1]]
          if (length(anchor_match) < 2 || !identical(anchor_match[[2]], y_anchor)) next
          
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
    if (identical((obj$currentProps %||% list())$svgSelectable, FALSE)) next
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
    if (
      identical(props$svgSelectable, FALSE) ||
      !nzchar(gid) || !nzchar(original_text) || !nzchar(next_text) || identical(original_text, next_text)
    ) next

    escaped_gid <- regex_escape(gid)
    pattern <- paste0(
      "<text\\b[^>]*(?:id|data-fig-id)\\s*=\\s*['\"]",
      escaped_gid,
      "['\"][^>]*>[\\s\\S]*?</text>"
    )
    matches <- gregexpr(pattern, svg, perl = TRUE)[[1]]
    if (length(matches) == 1 && matches[[1]] == -1) next
    match_lengths <- attr(matches, "match.length")

    for (i in seq_along(matches)) {
      start <- matches[[i]]
      len <- match_lengths[[i]]
      if (start < 0 || len <= 0) next
      chunk <- substr(svg, start, start + len - 1)
      replacement <- chunk
      replacement <- sub(
        ">[\\s\\S]*</text>$",
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

svg_set_inline_style <- function(tag, property, value) {
  value <- gsub("[\r\n]", " ", as.character(value), perl = TRUE)
  style_match <- regexec("\\bstyle\\s*=\\s*(['\"])(.*?)\\1", tag, perl = TRUE)
  style_parts <- regmatches(tag, style_match)[[1]]
  next_style <- paste0(property, ": ", value, ";")
  if (length(style_parts) >= 3) {
    style <- style_parts[[3]]
    property_pattern <- paste0("(?i)(^|;)\\s*", regex_escape(property), "\\s*:\\s*[^;]*;?")
    if (grepl(property_pattern, style, perl = TRUE)) {
      style <- sub(property_pattern, paste0("\\1 ", next_style), style, perl = TRUE)
    } else {
      style <- paste(trimws(style), next_style)
    }
    return(sub("\\bstyle\\s*=\\s*(['\"])(.*?)\\1", paste0("style=\"", style, "\""), tag, perl = TRUE))
  }
  sub("^<text\\b", paste0("<text style=\"", next_style, "\""), tag, perl = TRUE)
}

apply_svg_text_style_edits <- function(svg, manifest) {
  objects <- manifest$objects %||% list()
  style_props <- c("fontsize", "fontfamily", "fontweight", "fontstyle", "color", "rotation")
  legend_family_has_edit <- function(prefix, prop) {
    any(vapply(edit_entries, function(entry) {
      startsWith(as.character(entry$gid %||% ""), prefix) &&
        identical(as.character(entry$prop %||% ""), prop)
    }, logical(1)))
  }
  for (obj in objects) {
    gid <- as.character(obj$id %||% "")
    is_tick <- grepl("^[xy]tick\\.\\d+\\.\\d+$", gid)
    legend_prefix <- if (grepl("^legend_title\\.\\d+$", gid)) {
      "legend_title."
    } else if (grepl("^legend_text\\.\\d+\\.\\d+$", gid)) {
      "legend_text."
    } else {
      ""
    }
    should_apply <- function(prop) {
      has_edit(gid, prop) || (nzchar(legend_prefix) && legend_family_has_edit(legend_prefix, prop))
    }
    if ((!is_tick && !nzchar(legend_prefix)) || !any(vapply(style_props, should_apply, logical(1)))) next

    escaped_gid <- regex_escape(gid)
    pattern <- paste0("<text\\b(?=[^>]*\\bid\\s*=\\s*['\"]", escaped_gid, "['\"])[^>]*>")
    match <- regexpr(pattern, svg, perl = TRUE)
    if (length(match) == 0 || match[[1]] < 0) next
    tag <- regmatches(svg, match)
    props <- obj$currentProps %||% list()
    if (should_apply("fontsize")) tag <- svg_set_inline_style(tag, "font-size", paste0(props$fontsize, "pt"))
    if (should_apply("fontfamily")) tag <- svg_set_inline_style(tag, "font-family", props$fontfamily)
    if (should_apply("fontweight")) tag <- svg_set_inline_style(tag, "font-weight", props$fontweight)
    if (should_apply("fontstyle")) tag <- svg_set_inline_style(tag, "font-style", props$fontstyle)
    if (should_apply("color")) tag <- svg_set_inline_style(tag, "fill", props$color)
    if (should_apply("rotation")) {
      tag <- svg_set_inline_style(tag, "transform", paste0("rotate(", props$rotation, "deg)"))
      tag <- svg_set_inline_style(tag, "transform-box", "fill-box")
      tag <- svg_set_inline_style(tag, "transform-origin", "center")
    }
    start <- match[[1]]
    len <- attr(match, "match.length")[[1]]
    svg <- paste0(substr(svg, 1, start - 1), tag, substr(svg, start + len, nchar(svg)))
  }
  svg
}

r_layer_mapped_scale_kinds <- function(layer, plot_mapping = NULL) {
  effective_mapping <- r_effective_layer_mapping(layer, plot_mapping)
  fixed_params <- layer_params(layer)
  color_mapped <- any(c("colour", "color") %in% names(effective_mapping)) &&
    !any(c("colour", "color") %in% names(fixed_params))
  fill_mapped <- "fill" %in% names(effective_mapping) && !"fill" %in% names(fixed_params)
  c(
    if (color_mapped) "color" else character(),
    if (fill_mapped) "fill" else character()
  )
}

r_layer_drawable_data <- function(layer, data) {
  params <- layer$computed_geom_params %||% layer$geom_params %||% list()
  filtered <- suppressWarnings(tryCatch(
    layer$geom$handle_na(data, params),
    error = function(e) NULL
  ))
  list(data = filtered %||% data, verified = !is.null(filtered))
}

layer_svg_plan <- function(plot_obj) {
  built <- tryCatch(ggplot2::ggplot_build(plot_obj), error = function(e) NULL)
  if (is.null(built) || is.null(built$data) || length(plot_obj$layers) == 0) return(list())

  group_rows <- function(data) {
    if ("group" %in% names(data)) match(unique(data$group), data$group) else seq_len(nrow(data))
  }
  style_values <- function(data, name) {
    if (!name %in% names(data)) return(character())
    values <- as.character(data[[name]])
    unique(values[!is.na(values) & nzchar(values) & toupper(values) != "NA"])
  }
  visible_style_values <- function(values) {
    values <- as.character(unlist(values, use.names = FALSE))
    unique(values[!is.na(values) & nzchar(values) & toupper(values) != "NA"])
  }

  diagram_context <- any(vapply(
    plot_obj$layers,
    function(layer) !is.null(r_layer_diagram_metadata(layer)),
    logical(1)
  ))
  plans <- list()
  for (i in seq_along(plot_obj$layers)) {
    layer <- plot_obj$layers[[i]]
    explicit_diagram <- !is.null(r_layer_diagram_metadata(layer))
    geom <- geom_class(layer)
    kind <- layer_kind(geom)
    if (kind == "text") next
    data <- built$data[[i]]
    if (is.null(data) || nrow(data) == 0) next
    drawable <- r_layer_drawable_data(layer, data)
    data <- drawable$data
    if (is.null(data) || nrow(data) == 0) next
    segment_curve <- is_segment_curve_adapter_layer(layer)
    arrow <- layer$geom_params$arrow %||% NULL
    arrow_ends <- suppressWarnings(as.integer(arrow$ends %||% NA_integer_))
    arrow_count <- if (is.null(arrow)) {
      0L
    } else if (length(arrow_ends) > 0 && identical(arrow_ends[[1]], 3L)) {
      2L
    } else {
      1L
    }
    elements_per_row <- if (segment_curve) 1L + arrow_count else 1L
    grouped_rows <- group_rows(data)
    tags <- switch(
      geom,
      GeomPoint = c("circle", "rect", "path", "polygon"),
      GeomJitter = c("circle", "rect", "path", "polygon"),
      GeomLine = c("polyline", "path", "line"),
      GeomPath = c("polyline", "path", "line"),
      GeomSmooth = c("polyline", "path", "line"),
      GeomStep = c("polyline", "path", "line"),
      GeomDensity = c("polyline", "path", "line"),
      GeomFreqpoly = c("polyline", "path", "line"),
      GeomSegment = c("line", "polyline", "path", "polygon"),
      GeomCurve = c("polyline", "path", "line", "polygon"),
      GeomCol = c("rect", "polygon", "path"),
      GeomBar = c("rect", "polygon", "path"),
      GeomTile = c("rect", "polygon", "path"),
      GeomRect = c("rect", "polygon", "path"),
      GeomRaster = c("image", "rect"),
      GeomErrorbar = c("polyline", "line", "path"),
      GeomErrorbarh = c("polyline", "line", "path"),
      GeomLinerange = c("line", "polyline", "path"),
      GeomPointrange = c("line", "polyline", "path", "circle", "polygon"),
      GeomCrossbar = c("rect", "polyline", "line", "path", "polygon"),
      GeomViolin = c("polygon", "path"),
      GeomBoxplot = c("rect", "polygon"),
      GeomRibbon = c("polygon", "path"),
      GeomArea = c("polygon", "path"),
      GeomContour = c("path", "polyline"),
      GeomContourFilled = c("path", "polygon", "polyline"),
      switch(
        kind,
        collection = c("circle", "path", "polygon"),
        line = c("polyline", "path", "line"),
        patch = c("rect", "polygon", "path"),
        errorbar_container = c("polyline", "line", "path", "rect"),
        c("path", "polyline", "circle", "rect", "polygon", "line")
      )
    )

    if (segment_curve) {
      count <- max(1L, nrow(data) * elements_per_row)
    } else if (geom %in% c("GeomLine", "GeomPath", "GeomSmooth", "GeomStep", "GeomDensity", "GeomFreqpoly", "GeomContour", "GeomContourFilled")) {
      count <- max(1L, length(grouped_rows))
    } else if (geom %in% c("GeomErrorbar", "GeomErrorbarh")) {
      count <- nrow(data) * 3L
    } else if (identical(geom, "GeomPointrange")) {
      count <- nrow(data) * 2L
    } else if (identical(geom, "GeomLinerange")) {
      count <- nrow(data)
    } else if (identical(geom, "GeomCrossbar")) {
      count <- nrow(data) * 2L
    } else if (identical(geom, "GeomViolin")) {
      count <- length(grouped_rows)
    } else if (identical(geom, "GeomBoxplot")) {
      count <- length(grouped_rows)
    } else if (geom %in% c("GeomRibbon", "GeomArea")) {
      count <- length(grouped_rows)
    } else if (identical(geom, "GeomRaster")) {
      panel_rows <- if ("PANEL" %in% names(data)) match(unique(data$PANEL), data$PANEL) else 1L
      count <- length(panel_rows)
    } else {
      count <- max(1L, nrow(data))
    }
    plans[[length(plans) + 1]] <- list(
      gid = r_layer_manifest_gid(layer, i),
      geom = geom,
      kind = kind,
      tags = tags,
      count = count,
      layer_index = i,
      segment_curve = segment_curve,
      explicit_diagram = explicit_diagram,
      diagram_context = diagram_context,
      stroke_colors = visible_style_values(c(
        style_values(data, "colour"),
        if (identical(geom, "GeomBoxplot")) {
          param_value(layer$geom_params %||% list(), c("outlier.colour", "outlier.color"), NULL)
        } else {
          NULL
        }
      )),
      fill_colors = visible_style_values(c(
        style_values(data, "fill"),
        if (identical(geom, "GeomBoxplot")) {
          param_value(layer$geom_params %||% list(), c("outlier.fill"), NULL)
        } else {
          NULL
        }
      )),
      scale_kinds = r_layer_mapped_scale_kinds(layer, plot_obj$mapping),
      linetypes = style_values(data, "linetype"),
      allow_css_default_stroke = geom %in% c(
        "GeomLine", "GeomPath", "GeomSmooth", "GeomStep", "GeomDensity", "GeomFreqpoly"
      ),
      selection_mode = if (isTRUE(drawable$verified) && geom %in% c(
        "GeomPoint", "GeomJitter", "GeomLine", "GeomPath", "GeomSmooth", "GeomStep",
        "GeomDensity", "GeomFreqpoly", "GeomCol", "GeomBar", "GeomTile", "GeomRect",
        "GeomRaster", "GeomContour", "GeomContourFilled"
      )) "ordered" else "exact"
    )
  }
  plans
}

is_svg_data_candidate <- function(chunk) {
  if (grepl("\\bdata-fig-id\\s*=", chunk, perl = TRUE)) return(FALSE)
  if (grepl("\\bdata-scifigure-unresolved-owner\\s*=", chunk, perl = TRUE)) return(FALSE)
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

mark_svg_records_unresolved <- function(svg, records, owner_gid) {
  if (length(records) == 0 || !nzchar(owner_gid)) return(svg)
  starts <- vapply(records, function(record) record$start, numeric(1))
  records <- records[!duplicated(starts)]
  records <- records[order(vapply(records, function(record) record$start, numeric(1)), decreasing = TRUE)]
  for (record in records) {
    if (!is_svg_data_candidate(record$chunk)) next
    replacement <- sub(
      "^<([A-Za-z0-9:_-]+)\\b",
      paste0("<\\1 data-scifigure-unresolved-owner=\"", owner_gid, "\""),
      record$chunk,
      perl = TRUE
    )
    svg <- paste0(
      substr(svg, 1, record$start - 1),
      replacement,
      substr(svg, record$start + record$len, nchar(svg))
    )
  }
  svg
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

svg_tag_style_value <- function(chunk, property) {
  style_match <- regexec("\\bstyle\\s*=\\s*(['\"])(.*?)\\1", chunk, perl = TRUE)
  style_parts <- regmatches(chunk, style_match)[[1]]
  if (length(style_parts) < 3) return("")
  value_match <- regexec(
    paste0("(?i)(^|;)\\s*", regex_escape(property), "\\s*:\\s*([^;]+)"),
    style_parts[[3]],
    perl = TRUE
  )
  value_parts <- regmatches(style_parts[[3]], value_match)[[1]]
  if (length(value_parts) < 3) "" else trimws(value_parts[[3]])
}

svg_tag_name <- function(chunk) {
  parts <- regmatches(chunk, regexec("^<([A-Za-z0-9:_-]+)\\b", chunk, perl = TRUE))[[1]]
  if (length(parts) < 2) "" else parts[[2]]
}

svg_geometry_tag_records <- function(svg, tags) {
  if (length(tags) == 0) return(list())
  pattern <- paste0("<(", paste(tags, collapse = "|"), ")\\b[^>]*>")
  matches <- gregexpr(pattern, svg, perl = TRUE)[[1]]
  if (length(matches) == 1 && matches[[1]] == -1) return(list())
  lengths <- attr(matches, "match.length")
  records <- list()
  for (index in seq_along(matches)) {
    start <- matches[[index]]
    length_value <- lengths[[index]]
    if (start < 0 || length_value <= 0) next
    chunk <- substr(svg, start, start + length_value - 1)
    records[[length(records) + 1]] <- list(
      start = start,
      len = length_value,
      chunk = chunk,
      tag = svg_tag_name(chunk)
    )
  }
  records
}

svg_panel_clip_ids <- function(svg) {
  if (is.null(svg) || !nzchar(svg)) return(character())
  viewbox_match <- regexec(
    "viewBox\\s*=\\s*['\"]\\s*[-+0-9.eE]+\\s+[-+0-9.eE]+\\s+([-+0-9.eE]+)\\s+([-+0-9.eE]+)\\s*['\"]",
    svg,
    perl = TRUE
  )
  viewbox <- regmatches(svg, viewbox_match)[[1]]
  if (length(viewbox) < 3) return(character())
  total_width <- suppressWarnings(as.numeric(viewbox[[2]]))
  total_height <- suppressWarnings(as.numeric(viewbox[[3]]))
  if (!is.finite(total_width) || !is.finite(total_height)) return(character())

  ids <- character()
  for (block in svg_tags(svg, "<clipPath\\b[\\s\\S]*?</clipPath>")) {
    rect_tags <- svg_tags(block, "<rect\\b[^>]*>")
    if (length(rect_tags) == 0) next
    rect <- rect_tags[[1]]
    x <- svg_tag_number(rect, "x")
    y <- svg_tag_number(rect, "y")
    width <- svg_tag_number(rect, "width")
    height <- svg_tag_number(rect, "height")
    if (!all(is.finite(c(x, y, width, height))) || width <= 0 || height <= 0) next
    if (x <= 0.5 && y <= 0.5 && width >= total_width * 0.98 && height >= total_height * 0.98) next
    id_match <- regexec("\\bid\\s*=\\s*['\"]([^'\"]+)['\"]", block, perl = TRUE)
    id_parts <- regmatches(block, id_match)[[1]]
    if (length(id_parts) >= 2 && nzchar(id_parts[[2]])) ids <- c(ids, id_parts[[2]])
  }
  unique(ids)
}

svg_panel_geometry_records <- function(svg, tags) {
  panel_ids <- svg_panel_clip_ids(svg)
  if (length(panel_ids) == 0 || length(tags) == 0) return(list())
  records <- list()
  for (panel_id in panel_ids) {
    pattern <- paste0(
      "<g\\b[^>]*clip-path\\s*=\\s*['\"]url\\(#",
      regex_escape(panel_id),
      "\\)['\"][^>]*>[\\s\\S]*?</g>"
    )
    matches <- gregexpr(pattern, svg, perl = TRUE)[[1]]
    if (length(matches) == 1 && matches[[1]] == -1) next
    lengths <- attr(matches, "match.length")
    for (index in seq_along(matches)) {
      start <- matches[[index]]
      length_value <- lengths[[index]]
      if (start < 0 || length_value <= 0) next
      block <- substr(svg, start, start + length_value - 1)
      block_records <- svg_geometry_tag_records(block, tags)
      if (length(block_records) == 0) next
      for (record in block_records) {
        record$start <- record$start + start - 1
        records[[length(records) + 1]] <- record
      }
    }
  }
  if (length(records) == 0) return(list())
  records[order(vapply(records, function(record) record$start, numeric(1)))]
}

svg_layer_geometry_records <- function(
  svg,
  tags,
  explicit_diagram = FALSE,
  allow_verified_fallback = FALSE
) {
  records <- svg_panel_geometry_records(svg, tags)
  if (length(records) > 0) {
    attr(records, "scifigure_scope_verified") <- TRUE
    return(records)
  }
  if (!isTRUE(explicit_diagram) && !isTRUE(allow_verified_fallback)) return(records)

  records <- svg_geometry_tag_records(svg, tags)
  bounds <- svg_fallback_panel_bounds(svg)
  if (is.null(bounds)) {
    attr(records, "scifigure_scope_verified") <- FALSE
    return(records)
  }
  records <- Filter(function(record) svg_record_anchor_inside(record, bounds), records)
  attr(records, "scifigure_scope_verified") <- TRUE
  records
}

svg_fallback_panel_bounds <- function(svg) {
  viewbox_match <- regexec(
    "viewBox\\s*=\\s*['\"]\\s*[-+0-9.eE]+\\s+[-+0-9.eE]+\\s+([-+0-9.eE]+)\\s+([-+0-9.eE]+)\\s*['\"]",
    svg,
    perl = TRUE
  )
  viewbox <- regmatches(svg, viewbox_match)[[1]]
  if (length(viewbox) < 3) return(NULL)
  total_width <- suppressWarnings(as.numeric(viewbox[[2]]))
  total_height <- suppressWarnings(as.numeric(viewbox[[3]]))
  if (!all(is.finite(c(total_width, total_height))) || total_width <= 0 || total_height <= 0) return(NULL)

  candidates <- list()
  for (record in svg_geometry_tag_records(svg, c("rect"))) {
    chunk <- record$chunk
    rect <- list(
      x = svg_tag_number(chunk, "x"),
      y = svg_tag_number(chunk, "y"),
      width = svg_tag_number(chunk, "width"),
      height = svg_tag_number(chunk, "height")
    )
    values <- unlist(rect)
    if (!all(is.finite(values)) || rect$width <= 0 || rect$height <= 0) next
    if (rect$x <= 0.5 && rect$y <= 0.5 && rect$width >= total_width * 0.98 && rect$height >= total_height * 0.98) next
    if (rect$width < total_width * 0.25 || rect$height < total_height * 0.25) next
    if (rect$width >= total_width * 0.98 || rect$height >= total_height * 0.98) next
    if (
      grepl("fill:\\s*#FFFFFF", chunk, ignore.case = TRUE, perl = TRUE) &&
      grepl("stroke:\\s*none", chunk, ignore.case = TRUE, perl = TRUE)
    ) next
    candidates[[length(candidates) + 1L]] <- rect
  }
  if (length(candidates) == 0) return(NULL)
  areas <- vapply(candidates, function(rect) rect$width * rect$height, numeric(1))
  candidates[[which.max(areas)]]
}

svg_record_anchor <- function(record) {
  chunk <- record$chunk
  tag <- record$tag %||% svg_tag_name(chunk)
  if (tag == "circle") return(c(svg_tag_number(chunk, "cx"), svg_tag_number(chunk, "cy")))
  if (tag %in% c("rect", "image")) {
    x <- svg_tag_number(chunk, "x")
    y <- svg_tag_number(chunk, "y")
    width <- svg_tag_number(chunk, "width")
    height <- svg_tag_number(chunk, "height")
    return(c(x + width / 2, y + height / 2))
  }
  if (tag == "line") {
    return(c(
      mean(c(svg_tag_number(chunk, "x1"), svg_tag_number(chunk, "x2"))),
      mean(c(svg_tag_number(chunk, "y1"), svg_tag_number(chunk, "y2")))
    ))
  }
  if (tag %in% c("polyline", "polygon")) {
    points_match <- regexec("\\bpoints\\s*=\\s*['\"]([^'\"]+)['\"]", chunk, perl = TRUE)
    points_parts <- regmatches(chunk, points_match)[[1]]
    if (length(points_parts) >= 2) {
      values <- suppressWarnings(as.numeric(unlist(strsplit(gsub(",", " ", points_parts[[2]], fixed = TRUE), "[[:space:]]+", perl = TRUE))))
      values <- values[is.finite(values)]
      if (length(values) >= 2) return(c(mean(values[seq(1, length(values), by = 2)]), mean(values[seq(2, length(values), by = 2)])))
    }
  }
  if (tag == "path") {
    d_match <- regexec("\\bd\\s*=\\s*['\"]([^'\"]+)['\"]", chunk, perl = TRUE)
    d_parts <- regmatches(chunk, d_match)[[1]]
    if (length(d_parts) >= 2) {
      matches <- gregexpr("[-+]?(?:[0-9]*\\.)?[0-9]+(?:[eE][-+]?[0-9]+)?", d_parts[[2]], perl = TRUE)[[1]]
      if (!(length(matches) == 1 && matches[[1]] == -1)) {
        values <- suppressWarnings(as.numeric(regmatches(d_parts[[2]], list(matches))[[1]]))
        values <- values[is.finite(values)]
        if (length(values) >= 2) return(c(mean(values[seq(1, length(values), by = 2)]), mean(values[seq(2, length(values), by = 2)])))
      }
    }
  }
  c(NA_real_, NA_real_)
}

svg_record_anchor_inside <- function(record, bounds) {
  anchor <- svg_record_anchor(record)
  if (!all(is.finite(anchor))) return(FALSE)
  epsilon <- 0.5
  anchor[[1]] >= bounds$x - epsilon && anchor[[1]] <= bounds$x + bounds$width + epsilon &&
    anchor[[2]] >= bounds$y - epsilon && anchor[[2]] <= bounds$y + bounds$height + epsilon
}

svg_linetype_class <- function(value) {
  text <- tolower(as.character(value %||% "solid")[[1]])
  if (text %in% c("1", "solid")) return("solid")
  if (text %in% c("2", "dashed")) return("dashed")
  if (text %in% c("3", "dotted")) return("dotted")
  if (text %in% c("4", "dotdash")) return("dotdash")
  if (text %in% c("5", "longdash")) return("longdash")
  if (text %in% c("6", "twodash")) return("twodash")
  "unknown"
}

svg_tag_linetype_matches <- function(chunk, expected) {
  expected_class <- svg_linetype_class(expected)
  if (expected_class == "unknown") return(TRUE)
  dash_value <- svg_tag_style_value(chunk, "stroke-dasharray")
  has_dash <- nzchar(dash_value) && !tolower(dash_value) %in% c("none", "0", "0.00")
  if (expected_class == "solid") !has_dash else has_dash
}

svg_tag_stroke_matches <- function(chunk, expected_color) {
  stroke <- svg_tag_style_value(chunk, "stroke")
  nzchar(stroke) && colors_equal(stroke, expected_color)
}

svg_tag_effective_stroke_value <- function(chunk) {
  stroke <- svg_tag_style_value(chunk, "stroke")
  if (nzchar(stroke)) return(stroke)
  tag <- svg_tag_name(chunk)
  if (
    tag %in% c("line", "polyline", "path", "polygon", "circle", "rect") &&
    !grepl("stroke\\s*:\\s*none", chunk, ignore.case = TRUE, perl = TRUE)
  ) {
    # svglite puts the default black stroke in its stylesheet rather than each tag.
    return("#000000")
  }
  ""
}

svg_tag_stroke_matches_any <- function(chunk, expected_values) {
  stroke <- svg_tag_style_value(chunk, "stroke")
  svg_color_matches_any(stroke, expected_values)
}

svg_color_matches_any <- function(value, expected_values) {
  if (!nzchar(value) || length(expected_values) == 0) return(FALSE)
  any(vapply(expected_values, function(expected) colors_equal(value, expected), logical(1)))
}

svg_tag_linetype_matches_any <- function(chunk, expected_values) {
  if (length(expected_values) == 0) return(TRUE)
  any(vapply(expected_values, function(expected) svg_tag_linetype_matches(chunk, expected), logical(1)))
}

layer_svg_candidate_matches <- function(chunk, plan, allow_css_default_stroke = FALSE) {
  tag <- svg_tag_name(chunk)
  if (identical(plan$geom, "GeomRaster") && identical(tag, "image")) {
    return(!grepl("\\bdata-fig-id\\s*=", chunk, perl = TRUE))
  }
  if (!is_svg_data_candidate(chunk)) return(FALSE)

  stroke <- svg_tag_style_value(chunk, "stroke")
  if (
    allow_css_default_stroke &&
    !nzchar(stroke) &&
    colors_equal(svg_tag_effective_stroke_value(chunk), "#000000")
  ) {
    stroke <- "#000000"
  }
  fill <- svg_tag_style_value(chunk, "fill")
  stroke_match <- svg_color_matches_any(stroke, plan$stroke_colors %||% character())
  fill_match <- svg_color_matches_any(fill, plan$fill_colors %||% character())
  no_style_signature <- length(plan$stroke_colors %||% character()) == 0 && length(plan$fill_colors %||% character()) == 0
  if (no_style_signature) return(TRUE)

  if (plan$kind %in% c("line", "contour", "errorbar_container")) {
    return(stroke_match && svg_tag_linetype_matches_any(chunk, plan$linetypes %||% character()))
  }
  stroke_match || fill_match
}

segment_curve_rendered_values <- function(layer, built_data, name, param_names, fallback) {
  values <- as.character(unlist(layer_data_values(built_data, name), use.names = FALSE))
  values <- values[!is.na(values) & nzchar(values)]
  if (length(values) == 0) {
    params <- layer_params(layer)
    value <- param_value(params, param_names, fallback)
    values <- as.character(value %||% fallback)
  }
  values
}

segment_curve_arrow_count <- function(layer) {
  arrow <- layer$geom_params$arrow %||% NULL
  if (is.null(arrow) || length(arrow) == 0) return(0L)
  ends <- suppressWarnings(as.integer(arrow$ends %||% NA_integer_))
  if (length(ends) > 0 && identical(ends[[1]], 3L)) 2L else 1L
}

find_svg_style_candidate <- function(records, start_index, tags, color, linetype, require_linetype = TRUE) {
  if (length(records) == 0) return(NA_integer_)
  for (index in seq.int(max(1L, start_index), length(records))) {
    record <- records[[index]]
    if (!record$tag %in% tags || !is_svg_data_candidate(record$chunk)) next
    if (!svg_tag_stroke_matches(record$chunk, color)) next
    if (require_linetype && !svg_tag_linetype_matches(record$chunk, linetype)) next
    return(index)
  }
  NA_integer_
}

segment_curve_svg_selection <- function(
  svg,
  layer,
  layer_index,
  built_data,
  scale_catalog,
  default_gid,
  plot_mapping = NULL,
  allow_verified_fallback = FALSE
) {
  data <- built_data[[layer_index]] %||% NULL
  if (is.null(data) || nrow(data) == 0) return(list(selections = list(), ambiguous_records = list()))
  data <- r_layer_drawable_data(layer, data)$data
  if (is.null(data) || nrow(data) == 0) return(list(selections = list(), ambiguous_records = list()))

  geom <- geom_class(layer)
  row_count <- nrow(data)
  colors <- segment_curve_rendered_values(layer, data, "colour", c("colour", "color"), "black")
  linetypes <- segment_curve_rendered_values(layer, data, "linetype", c("linetype"), "solid")
  colors <- rep(colors, length.out = row_count)
  linetypes <- rep(linetypes, length.out = row_count)
  arrow_count <- segment_curve_arrow_count(layer)
  explicit_diagram <- !is.null(r_layer_diagram_metadata(layer))
  body_tags <- if (identical(geom, "GeomSegment")) c("line", "polyline", "path") else c("polyline", "path", "line")
  arrow_tags <- if (identical(geom, "GeomSegment")) c("polygon", "polyline", "path") else c("polyline", "path", "polygon")
  records <- svg_layer_geometry_records(
    svg,
    unique(c(body_tags, arrow_tags)),
    explicit_diagram = explicit_diagram,
    allow_verified_fallback = allow_verified_fallback
  )
  scope_verified <- isTRUE(attr(records, "scifigure_scope_verified"))
  matching_records <- vapply(records, function(record) {
    if (!is_svg_data_candidate(record$chunk)) return(FALSE)
    stroke <- svg_tag_style_value(record$chunk, "stroke")
    if (!svg_color_matches_any(stroke, colors)) return(FALSE)
    body_match <- record$tag %in% body_tags && svg_tag_linetype_matches_any(record$chunk, linetypes)
    arrow_match <- arrow_count > 0 && record$tag %in% arrow_tags
    body_match || arrow_match
  }, logical(1))
  ambiguous_records <- records[matching_records]
  expected_record_count <- row_count * (1L + arrow_count)
  matching_indices <- which(matching_records)
  if (
    length(matching_indices) < expected_record_count ||
    (explicit_diagram && !scope_verified && length(matching_indices) != expected_record_count)
  ) {
    return(list(selections = list(), ambiguous_records = ambiguous_records))
  }
  owned_indices <- matching_indices[seq_len(expected_record_count)]
  selections <- list()
  selected_indices <- integer()
  cursor <- 1L

  for (row_index in seq_len(row_count)) {
    body_index <- find_svg_style_candidate(
      records, cursor, body_tags, colors[[row_index]], linetypes[[row_index]], require_linetype = TRUE
    )
    if (is.na(body_index)) return(list(selections = list(), ambiguous_records = ambiguous_records))
    row_selection <- list(body_index)
    next_index <- body_index + 1L
    if (arrow_count > 0) {
      for (arrow_index in seq_len(arrow_count)) {
        candidate_index <- find_svg_style_candidate(
          records, next_index, arrow_tags, colors[[row_index]], linetypes[[row_index]], require_linetype = FALSE
        )
        if (is.na(candidate_index)) return(list(selections = list(), ambiguous_records = ambiguous_records))
        row_selection <- c(row_selection, candidate_index)
        next_index <- candidate_index + 1L
      }
    }
    for (selection_index in seq_along(row_selection)) {
      record_index <- row_selection[[selection_index]]
      is_arrow <- selection_index > 1L
      selected_indices <- c(selected_indices, record_index)
      selections[[length(selections) + 1]] <- list(
        record = records[[record_index]],
        gid = if (explicit_diagram) {
          default_gid
        } else if (is_arrow) {
          paste0("r.arrow.", layer_index - 1)
        } else {
          get_svg_candidate_group_gid(
            records[[record_index]]$chunk,
            default_gid,
            scale_catalog,
            r_layer_mapped_scale_kinds(layer, plot_mapping)
          )
        }
      )
    }
    cursor <- next_index
  }
  if (!identical(selected_indices, owned_indices)) {
    return(list(selections = list(), ambiguous_records = ambiguous_records))
  }
  list(selections = selections, ambiguous_records = list())
}

inject_segment_curve_layer_svg_ids <- function(
  svg,
  plot_obj,
  layer_index,
  built_data,
  scale_catalog,
  allow_verified_fallback = FALSE
) {
  layer <- plot_obj$layers[[layer_index]]
  if (!is_segment_curve_adapter_layer(layer)) return(svg)
  default_gid <- r_layer_manifest_gid(layer, layer_index)
  selection_result <- segment_curve_svg_selection(
    svg,
    layer,
    layer_index,
    built_data,
    scale_catalog,
    default_gid,
    plot_obj$mapping,
    allow_verified_fallback = allow_verified_fallback
  )
  selections <- selection_result$selections %||% list()
  if (length(selections) == 0) {
    return(mark_svg_records_unresolved(svg, selection_result$ambiguous_records %||% list(), default_gid))
  }
  for (selection in rev(selections)) {
    record <- selection$record
    replacement <- sub(
      "^<([A-Za-z0-9:_-]+)\\b",
      paste0("<\\1 data-fig-id=\"", selection$gid, "\""),
      record$chunk,
      perl = TRUE
    )
    svg <- paste0(
      substr(svg, 1, record$start - 1),
      replacement,
      substr(svg, record$start + record$len, nchar(svg))
    )
  }
  svg
}

get_svg_candidate_group_gid <- function(chunk, default_layer_gid, scale_catalog, allowed_kinds = c("color", "fill")) {
  allowed_kinds <- unique(as.character(unlist(allowed_kinds, use.names = FALSE)))
  if (length(allowed_kinds) == 0) return(default_layer_gid)
  candidates <- character()
  for (entry in scale_catalog$entries %||% list()) {
    if (!entry$kind %in% allowed_kinds) next
    style_value <- if (entry$kind == "fill") {
      svg_tag_style_value(chunk, "fill")
    } else {
      svg_tag_effective_stroke_value(chunk)
    }
    if (!nzchar(style_value) || tolower(style_value) %in% c("none", "transparent")) next
    for (index in seq_along(entry$colors)) {
      group_id <- paste0("r.group.", entry$kind, ".", entry$ordinal, ".", index - 1)
      original_color <- as.character(entry$colors[[index]])
      current_color <- latest_string(
        group_id,
        if (entry$kind == "fill") "facecolor" else "color",
        original_color
      )
      if (colors_equal(style_value, current_color)) candidates <- c(candidates, group_id)
    }
  }
  candidates <- unique(candidates)
  if (length(candidates) == 1) candidates[[1]] else default_layer_gid
}

inject_next_svg_tag_attrs <- function(svg, plan, scale_catalog) {
  if (plan$count <= 0 || length(plan$tags) == 0 || !nzchar(plan$gid)) return(svg)
  records <- svg_layer_geometry_records(
    svg,
    plan$tags,
    explicit_diagram = plan$explicit_diagram,
    allow_verified_fallback = plan$diagram_context
  )
  if (length(records) == 0) return(svg)
  explicit_candidates <- list()
  css_default_candidates <- list()
  for (record in records) {
    chunk <- record$chunk
    candidate <- list(start = record$start, len = record$len, chunk = chunk)
    if (layer_svg_candidate_matches(chunk, plan)) {
      explicit_candidates[[length(explicit_candidates) + 1]] <- candidate
      next
    }
    if (
      isTRUE(plan$allow_css_default_stroke) &&
      layer_svg_candidate_matches(chunk, plan, allow_css_default_stroke = TRUE)
    ) {
      css_default_candidates[[length(css_default_candidates) + 1]] <- candidate
    }
  }
  candidates <- explicit_candidates
  if (length(candidates) != plan$count && isTRUE(plan$allow_css_default_stroke)) {
    candidates <- c(explicit_candidates, css_default_candidates)
  }
  candidates <- candidates[order(vapply(candidates, function(candidate) candidate$start, numeric(1)))]
  selection_mode <- if (
    isTRUE(plan$explicit_diagram) && !isTRUE(attr(records, "scifigure_scope_verified"))
  ) "exact" else plan$selection_mode
  if (identical(selection_mode, "ordered")) {
    if (length(candidates) < plan$count) {
      return(mark_svg_records_unresolved(svg, candidates, plan$gid))
    }
    candidates <- candidates[seq_len(plan$count)]
  } else if (length(candidates) != plan$count) {
    return(mark_svg_records_unresolved(svg, candidates, plan$gid))
  }

  for (idx in rev(seq_along(candidates))) {
    candidate <- candidates[[idx]]
    resolved_gid <- if (isTRUE(plan$explicit_diagram)) {
      plan$gid
    } else {
      get_svg_candidate_group_gid(candidate$chunk, plan$gid, scale_catalog, plan$scale_kinds %||% character())
    }
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
    svg <- if (isTRUE(plan$segment_curve)) {
      inject_segment_curve_layer_svg_ids(
        svg,
        plot_obj,
        plan$layer_index,
        built_data,
        scale_catalog,
        allow_verified_fallback = plan$diagram_context
      )
    } else {
      inject_next_svg_tag_attrs(svg, plan, scale_catalog)
    }
  }
  svg
}

r_manifest_legend_id <- function(id) {
  if (grepl("^legend_(title|text|key|line|patch|collection)\\.0", id)) return("legend.0")
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
  if (grepl("^(legend|r\\.scale\\.|r\\.guide\\.|r\\.facet\\.layout\\.)", id)) return("container")
  if (kind %in% c("subplot", "colorbar")) return("figure")
  if (kind %in% c("line", "collection", "patch", "heatmap", "contour", "contourf", "errorbar_container", "boxplot_container", "violinplot_container")) return("data")
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
  scope <- if (!is.null(legend_id) || grepl("^r\\.(group|scale|guide|facet\\.layout)\\.", id)) "container" else if (figure_level) "figure" else if (!is.null(subplot_id)) "subplot" else "figure"
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
    "aesthetic", "groupKey", "dataKey", "facetKey", "axisKey", "guideType",
    "textSource", "statClass", "diagramId", "diagramType", "diagramObjectId",
    "nodeId", "edgeId", "sourceNodeId", "targetNodeId"
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
  scale_ids <- r_manifest_string_values(obj[["scaleIds"]])
  if (length(scale_ids) > 0) relation[["scaleIds"]] <- as.list(scale_ids)
  if (!is.null(legend_id)) relation[["legendId"]] <- legend_id
  for (key in c("legendId", "legendTitleId", "legendTextId", "colorbarId", "mappableId", "annotationId", "arrowId", "textId", "semanticGuideId")) {
    relation <- r_manifest_relation_scalar(relation, key, obj[[key]])
  }
  for (key in c("legendTextIds", "legendMarkerIds")) {
    values <- r_manifest_string_values(obj[[key]])
    if (length(values) > 0) relation[[key]] <- as.list(values)
  }
  mappable_ids <- r_manifest_string_values(obj[["mappableIds"]])
  if (length(mappable_ids) > 0) relation[["mappableIds"]] <- as.list(mappable_ids)
  semantic_scope <- relation[["subplotId"]] %||% if (length(relation[["subplotIds"]] %||% list()) == 1) relation[["subplotIds"]][[1]] else "figure"
  semantic_key <- paste(role, semantic_scope, sep = ":")
  if (!is.null(relation$diagramId) && !is.null(relation$diagramObjectId)) {
    semantic_key <- paste(
      "diagram", relation$diagramId, role, relation$diagramObjectId,
      sep = ":"
    )
  } else if (grepl("^r\\.group\\.", id)) {
    semantic_key <- paste("ggplot_group", relation$aesthetic %||% "unknown", relation$groupKey %||% id, sep = ":")
  } else if (grepl("^r\\.scale\\.", id)) {
    semantic_key <- paste("ggplot_scale", relation$aesthetic %||% "unknown", relation$scaleKey %||% id, sep = ":")
  } else if (grepl("^r\\.guide\\.", id)) {
    semantic_key <- paste("ggplot_guide", relation$guideKey %||% id, sep = ":")
  } else if (grepl("^r\\.facet\\.layout\\.", id)) {
    semantic_key <- paste("ggplot_facet_layout", relation$facetKey %||% "layout", sep = ":")
  } else if (grepl("^r\\.layer\\.", id)) {
    semantic_key <- paste(role, "layer", relation$layerKey %||% obj$source$layerSignature %||% role, sep = ":")
  } else if (grepl("^r\\.arrow\\.", id)) {
    semantic_key <- paste(role, "arrow", relation$layerKey %||% relation$layerId %||% id, sep = ":")
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
  if (grepl("^r\\.(layer|group|heatmap)\\.", id) || kind %in% c("line", "collection", "patch", "heatmap", "contour", "contourf", "errorbar_container", "boxplot_container", "violinplot_container")) {
    identity$seriesKey <- if (grepl("^r\\.group\\.", id)) {
      paste("r-series", relation$aesthetic %||% "unknown", relation$groupKey %||% id, sep = ":")
    } else {
      paste("r-series", semantic_key, sep = ":")
    }
  }
  if (!is.null(relation$diagramId) && !is.null(relation$diagramObjectId)) {
    identity$seriesKey <- paste("diagram", relation$diagramId, role, relation$diagramObjectId, sep = ":")
  }
  if (length(relation) > 0) identity$relation <- relation
  identity
}

r_structural_relation <- function(identity) {
  relation <- identity$relation %||% list()
  stable_fields <- c(
    "aesthetic", "groupKey", "dataKey", "facetKey", "axisKey",
    "layerKey", "scaleKey", "guideKey", "diagramId", "diagramType",
    "diagramObjectId", "nodeId", "edgeId", "sourceNodeId", "targetNodeId"
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
  obj$scaleIds <- NULL
  obj$guideId <- NULL
  obj$guideKey <- NULL
  obj$guideType <- NULL
  obj$semanticGuideId <- NULL
  obj$legendId <- NULL
  obj$legendTitleId <- NULL
  obj$legendTextId <- NULL
  obj$legendTextIds <- NULL
  obj$legendMarkerIds <- NULL
  obj$aesthetic <- NULL
  obj$groupKey <- NULL
  obj$dataKey <- NULL
  obj$facetKey <- NULL
  obj$axisKey <- NULL
  obj$textSource <- NULL
  obj$statClass <- NULL
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
    "layerKey", "scaleKey", "guideKey", "diagramId", "diagramType",
    "diagramObjectId", "nodeId", "edgeId", "sourceNodeId", "targetNodeId"
  )
  relation[intersect(stable_fields, names(relation))]
}

r_normalize_structural_fingerprint <- function(value) {
  fingerprint <- as.character(unwrap_manifest_value(value) %||% "")
  if (!startsWith(fingerprint, "r-v2:")) return(fingerprint)
  gsub("[\\r\\n\\t ]+", "", fingerprint, perl = TRUE)
}

r_parse_structural_fingerprint <- function(value) {
  fingerprint <- r_normalize_structural_fingerprint(value)
  if (!startsWith(fingerprint, "r-v2:")) return(NULL)
  tryCatch(
    jsonlite::fromJSON(
      rawToChar(jsonlite::base64_dec(substring(fingerprint, nchar("r-v2:") + 1L))),
      simplifyVector = FALSE
    ),
    error = function(e) NULL
  )
}

r_legacy_text_role_identity_evidence_compatible <- function(object, evidence) {
  if (
    !identical(as.character(object$role %||% ""), "ggplot_text_data") ||
    !startsWith(as.character(object$id %||% ""), "r.text.") ||
    is.null(evidence$stableKey) ||
    !identical(evidence$stableKey, as.character(object$stableKey %||% "")) ||
    is.null(evidence$semanticKey) ||
    !identical(evidence$semanticKey, as.character(identity_manifest_value(object$identity, "semanticKey") %||% "")) ||
    is.null(evidence$relation$dataKey) ||
    !r_identity_json_equal(evidence$relation$dataKey, r_identity_relation_value(object$identity)$dataKey %||% NULL)
  ) {
    return(FALSE)
  }
  legacy <- r_parse_structural_fingerprint(evidence$fingerprint)
  current <- r_parse_structural_fingerprint(object$fingerprint)
  if (
    is.null(legacy) || is.null(current) ||
    !identical(as.character(legacy$role %||% ""), "ggplot_text_annotation") ||
    !identical(as.character(current$role %||% ""), "ggplot_text_data")
  ) {
    return(FALSE)
  }
  legacy$role <- current$role
  r_identity_json_equal(legacy, current)
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
  ) && !r_legacy_text_role_identity_evidence_compatible(object, evidence)) return(FALSE)
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

r_gid_remap_family <- function(value) {
  gid <- as.character(unwrap_manifest_value(value) %||% "")
  if (!grepl("^(r\\.|axis\\.[xy]\\.|[xy]tick\\.|legend(?:_title|_text)?\\.|title\\.|xlabel\\.|ylabel\\.|grid\\.|spine\\.|subplot\\.|facet\\.strip\\.)", gid, perl = TRUE)) {
    return("")
  }
  gsub("[0-9]+", "#", gid, perl = TRUE)
}

r_can_remap_gid <- function(requested_gid, resolved_gid) {
  requested_family <- r_gid_remap_family(requested_gid)
  resolved_family <- r_gid_remap_family(resolved_gid)
  nzchar(requested_family) && identical(requested_family, resolved_family)
}

r_legacy_continuous_target <- function(objects, requested_gid) {
  matched <- regexec(
    "^r\\.(scale|colorbar|heatmap)\\.(color|fill)(?:\\.continuous)?\\.([0-9]+)$",
    requested_gid,
    perl = TRUE
  )
  parts <- regmatches(requested_gid, matched)[[1]]
  if (length(parts) != 4) return(NULL)
  family <- parts[[2]]
  aesthetic <- parts[[3]]
  source_index <- suppressWarnings(as.integer(parts[[4]]))
  if (is.na(source_index)) return(NULL)
  id_prefix <- if (identical(family, "scale")) {
    paste0("r.scale.", aesthetic, ".continuous.")
  } else {
    paste0("r.", family, ".", aesthetic, ".")
  }
  candidates <- Filter(function(object) {
    startsWith(as.character(object$id %||% ""), id_prefix) &&
      identical(
        suppressWarnings(as.integer(object$currentProps$sourceScaleIndex %||% NA_integer_)),
        source_index
      )
  }, objects)
  if (length(candidates) == 1) candidates[[1]] else NULL
}

r_legacy_continuous_evidence_compatible <- function(object, entry) {
  for (field in c("stableKey")) {
    supplied <- unwrap_manifest_value(entry[[field]])
    if (present_manifest_value(supplied) && !identical(as.character(supplied), as.character(object[[field]] %||% ""))) {
      return(FALSE)
    }
  }
  for (field in c("semanticKey", "seriesKey")) {
    supplied <- identity_manifest_value(entry$identity, field)
    expected <- identity_manifest_value(object$identity, field)
    if (present_manifest_value(supplied) && !identical(as.character(supplied), as.character(expected %||% ""))) {
      return(FALSE)
    }
  }
  supplied_relation <- r_identity_relation_value(entry$identity)
  expected_relation <- r_identity_relation_value(object$identity)
  for (field in c("aesthetic", "groupKey", "dataKey", "facetKey", "axisKey", "layerKey")) {
    supplied <- supplied_relation[[field]] %||% NULL
    if (present_manifest_value(supplied) && !r_identity_json_equal(supplied, expected_relation[[field]] %||% NULL)) {
      return(FALSE)
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
    legacy_continuous_object <- if (is.null(exact_object)) {
      r_legacy_continuous_target(objects, gid)
    } else {
      NULL
    }
    if (!is.null(legacy_continuous_object) && r_legacy_continuous_evidence_compatible(legacy_continuous_object, entry)) {
      resolved_gid <- as.character(legacy_continuous_object$id %||% "")
      warnings[[length(warnings) + 1]] <- list(
        type = "legacy_target_alias",
        gid = gid,
        prop = prop,
        patchIndex = index - 1L,
        resolvedGid = resolved_gid,
        message = paste0(
          gid,
          " was migrated from the legacy absolute ggplot scale index to ",
          resolved_gid,
          "."
        )
      )
      resolved <- entry
      resolved[[".__requestedEntry"]] <- entry
      resolved[[".__patchIndex"]] <- index - 1L
      resolved[[".__resolvedGid"]] <- resolved_gid
      resolved[[".__legacyTargetAlias"]] <- TRUE
      resolved$gid <- resolved_gid
      accepted[[length(accepted) + 1]] <- resolved
      next
    }
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
      if (isTRUE(exact_object$currentProps$identityAmbiguous)) {
        reject_entry(
          entry,
          index - 1L,
          "unsupported_prop",
          gid,
          prop,
          paste0(gid, ".", prop, " is disabled because the R scale group identity is ambiguous.")
        )
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

    resolved_gid <- as.character(candidates[[1]]$id)
    if (isTRUE(candidates[[1]]$currentProps$identityAmbiguous)) {
      reject_entry(
        entry,
        index - 1L,
        "ambiguous_identity",
        gid,
        prop,
        paste0(gid, " resolves to an R scale group with ambiguous identity.")
      )
      next
    }
    if (!identical(resolved_gid, gid) && (is.null(exact_object) || !r_can_remap_gid(gid, resolved_gid))) {
      reject_entry(
        entry,
        index - 1L,
        "identity_mismatch",
        gid,
        prop,
        paste0(gid, " identity matched an object outside the requested R GID family."),
        list(candidateGids = list(resolved_gid))
      )
      next
    }

    resolved <- entry
    resolved[[".__requestedEntry"]] <- entry
    resolved[[".__patchIndex"]] <- index - 1L
    resolved[[".__resolvedGid"]] <- resolved_gid
    resolved$gid <- resolved_gid
    accepted[[length(accepted) + 1]] <- resolved
  }

  list(accepted = accepted, rejected = rejected, warnings = warnings)
}

validate_r_diagram_edit_resolution <- function(manifest, resolution) {
  objects <- manifest$objects %||% list()
  object_by_id <- setNames(objects, vapply(objects, function(obj) as.character(obj$id %||% ""), character(1)))
  accepted <- list()
  rejected <- resolution$rejected %||% list()
  warnings <- resolution$warnings %||% list()

  for (entry in resolution$accepted %||% list()) {
    gid <- as.character(unwrap_manifest_value(entry$gid) %||% "")
    prop <- as.character(unwrap_manifest_value(entry$prop) %||% "")
    object <- object_by_id[[gid]] %||% NULL
    role <- as.character(object$role %||% "")
    if (!startsWith(role, "diagram_")) {
      accepted[[length(accepted) + 1L]] <- entry
      next
    }

    editable <- as.character(unlist(object$editable %||% list(), use.names = FALSE))
    capabilities <- object$propertyCapabilities %||% list()
    supported <- prop %in% editable && any(vapply(capabilities, function(capability) {
      identical(as.character(capability$prop %||% ""), prop) &&
        !identical(as.character(capability$replay %||% ""), "unsupported")
    }, logical(1)))
    if (supported) {
      accepted[[length(accepted) + 1L]] <- entry
      next
    }

    requested_entry <- entry[[".__requestedEntry"]] %||% entry
    patch_index <- suppressWarnings(as.integer(entry[[".__patchIndex"]] %||% -1L))
    warnings[[length(warnings) + 1L]] <- list(
      type = "unsupported_prop",
      gid = as.character(unwrap_manifest_value(requested_entry$gid) %||% gid),
      prop = prop,
      patchIndex = patch_index,
      message = paste0(gid, ".", prop, " is not replayable in the R manifest.")
    )
    rejected[[length(rejected) + 1L]] <- requested_entry
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

  effective_prop_for_object <- function(object, prop) {
    prop <- as.character(prop)
    if (
      identical(prop, "facecolor") &&
      identical(as.character(object$currentProps$adapterFamily %||% ""), "point") &&
      !isTRUE(object$currentProps$fillSupported)
    ) {
      return("color")
    }
    if (
      prop %in% c("color", "edgecolor") &&
      identical(as.character(object$currentProps$adapterFamily %||% ""), "point")
    ) {
      editable <- as.character(unlist(object$editable %||% list(), use.names = FALSE))
      return(if ("edgecolor" %in% editable) "edgecolor" else "color")
    }
    if (
      identical(prop, "linewidth") &&
      identical(as.character(object$currentProps$adapterFamily %||% ""), "errorbar")
    ) {
      return("elinewidth")
    }
    if (
      identical(prop, "median_color") &&
      identical(as.character(object$currentProps$adapterFamily %||% ""), "boxplot")
    ) {
      return("color")
    }
    if (
      identical(prop, "color") &&
      identical(as.character(object$currentProps$adapterFamily %||% ""), "violin")
    ) {
      return("edgecolor")
    }
    prop
  }

  is_superseded_entry <- function(entry_index, gid, effective_prop) {
    if (entry_index >= length(entries)) return(FALSE)
    current_object <- object_by_id[[gid]]
    if (
      identical(effective_prop, "outlier_fill") &&
      identical(as.character(current_object$currentProps$adapterFamily %||% ""), "boxplot") &&
      !isTRUE(current_object$currentProps$outlierFillSupported)
    ) {
      for (later_index in seq(entry_index + 1L, length(entries))) {
        later <- entries[[later_index]]
        if (
          identical(as.character(unwrap_manifest_value(later$gid) %||% ""), gid) &&
          identical(as.character(unwrap_manifest_value(later$prop) %||% ""), "outlier_shape")
        ) {
          return(TRUE)
        }
      }
    }
    for (later_index in seq(entry_index + 1L, length(entries))) {
      later <- entries[[later_index]]
      later_gid <- as.character(unwrap_manifest_value(later$gid) %||% "")
      if (!identical(later_gid, gid)) next
      later_object <- object_by_id[[later_gid]]
      if (is.null(later_object)) next
      later_prop <- effective_prop_for_object(later_object, unwrap_manifest_value(later$prop) %||% "")
      if (identical(later_prop, effective_prop)) return(TRUE)
    }
    FALSE
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
    is_legacy_target_alias <- isTRUE(entry[[".__legacyTargetAlias"]])
    confirmation_evidence <- if (is_legacy_target_alias) list() else r_entry_identity_evidence(requested_entry)
    if (length(confirmation_evidence) > 0 && (is.null(object) || !r_object_matches_identity_evidence(object, confirmation_evidence))) {
      confirmation_candidates <- Filter(function(candidate) {
        r_object_matches_identity_evidence(candidate, confirmation_evidence)
      }, objects)
      if (length(confirmation_candidates) == 1) {
        remapped_gid <- as.character(confirmation_candidates[[1]]$id %||% "")
        if (!r_can_remap_gid(requested_gid, remapped_gid)) {
          reject_entry(
            requested_entry,
            patch_index,
            "identity_mismatch",
            requested_gid,
            prop,
            paste0(requested_gid, " post-render identity matched an object outside the requested R GID family."),
            list(candidateGids = list(remapped_gid))
          )
          next
        }
        gid <- remapped_gid
        object <- confirmation_candidates[[1]]
      } else if (length(confirmation_candidates) > 1) {
        reject_entry(
          requested_entry,
          patch_index,
          "ambiguous_identity",
          requested_gid,
          prop,
          paste0(requested_gid, " post-render identity matches multiple R manifest objects."),
          list(candidateGids = as.list(vapply(confirmation_candidates, function(candidate) as.character(candidate$id), character(1))))
        )
        next
      }
    }
    if (is.null(object)) {
      reject_entry(requested_entry, patch_index, "missing_gid", requested_gid, prop, paste0("R manifest is missing gid ", gid, "."))
      next
    }
    if (
      identical(prop, "aspect") &&
      grepl("^subplot\\.\\d+$", requested_gid) &&
      identical(as.character(object$role %||% ""), "ggplot_facet_panel")
    ) {
      facet_layout <- object_by_id[["r.facet.layout.0"]]
      if (!is.null(facet_layout)) {
        object <- facet_layout
        gid <- "r.facet.layout.0"
        warnings[[length(warnings) + 1]] <- list(
          type = "legacy_target_alias",
          gid = requested_gid,
          prop = prop,
          patchIndex = patch_index,
          resolvedGid = gid,
          message = paste0(requested_gid, ".aspect was migrated to the shared ggplot facet layout.")
        )
      }
    }
    effective_prop <- effective_prop_for_object(object, prop)
    legacy_prop_alias <- NULL
    if (
      identical(prop, "facecolor") &&
      identical(as.character(object$currentProps$adapterFamily %||% ""), "point") &&
      !isTRUE(object$currentProps$fillSupported)
    ) {
      legacy_prop_alias <- list(
        fromProp = prop,
        toProp = effective_prop,
        message = paste0(requested_gid, ".facecolor was migrated to visible point color for a non-fillable ggplot shape.")
      )
    } else if (
      identical(prop, "median_color") &&
      identical(as.character(object$currentProps$adapterFamily %||% ""), "boxplot")
    ) {
      legacy_prop_alias <- list(
        fromProp = prop,
        toProp = effective_prop,
        message = paste0(requested_gid, ".median_color is a legacy alias and was migrated to the whole boxplot outline color.")
      )
    } else if (
      identical(prop, "color") &&
      identical(as.character(object$currentProps$adapterFamily %||% ""), "violin")
    ) {
      legacy_prop_alias <- list(
        fromProp = prop,
        toProp = effective_prop,
        message = paste0(requested_gid, ".color is a legacy alias and was migrated to the violin edgecolor.")
      )
    }
    if (!is.null(legacy_prop_alias)) {
      warnings[[length(warnings) + 1]] <- list(
        type = "legacy_prop_alias",
        gid = requested_gid,
        prop = prop,
        patchIndex = patch_index,
        fromProp = legacy_prop_alias$fromProp,
        toProp = legacy_prop_alias$toProp,
        message = legacy_prop_alias$message
      )
    }
    if (grepl("^r\\.group\\.", gid) && identical(object$currentProps$scaleActive, FALSE)) {
      reject_entry(
        requested_entry,
        patch_index,
        "no_setter",
        requested_gid,
        prop,
        paste0(gid, ".", prop, " is dormant behind a layer-level style override and cannot keep data and legend output consistent.")
      )
      next
    }
    if (is_superseded_entry(index, gid, effective_prop)) {
      acknowledgement <- requested_entry
      if (!identical(requested_gid, gid)) acknowledgement$resolvedGid <- gid
      acknowledgement$superseded <- TRUE
      applied[[length(applied) + 1]] <- acknowledgement
      next
    }
    editable <- as.character(unlist(object$editable %||% list(), use.names = FALSE))
    capabilities <- object$propertyCapabilities %||% list()
    supported <- effective_prop %in% editable && any(vapply(capabilities, function(capability) {
      identical(as.character(capability$prop %||% ""), effective_prop) &&
        !identical(as.character(capability$replay %||% ""), "unsupported")
    }, logical(1)))
    if (!supported) {
      reject_entry(requested_entry, patch_index, "unsupported_prop", requested_gid, prop, paste0(gid, ".", prop, " is not replayable in the R manifest."))
      next
    }

    entry_stable_key <- unwrap_manifest_value(entry$stableKey)
    if (!is_legacy_target_alias && present_manifest_value(entry_stable_key) && !identical(as.character(entry_stable_key), as.character(object$stableKey %||% ""))) {
      reject_entry(requested_entry, patch_index, "identity_mismatch", requested_gid, prop, paste0(gid, " stableKey does not match the R manifest object."), list(field = "stableKey"))
      next
    }
    entry_fingerprint_version <- suppressWarnings(as.integer(unwrap_manifest_value(entry$fingerprintVersion)))
    if (
      !is_legacy_target_alias &&
      length(entry_fingerprint_version) == 1 && !is.na(entry_fingerprint_version) && entry_fingerprint_version == 2 &&
      identical(as.integer(object$fingerprintVersion %||% 0), 2) &&
      present_manifest_value(entry$fingerprint) &&
      !identical(
        r_normalize_structural_fingerprint(entry$fingerprint),
        r_normalize_structural_fingerprint(object$fingerprint)
      ) && !r_legacy_text_role_identity_evidence_compatible(object, r_entry_identity_evidence(entry))
    ) {
      reject_entry(requested_entry, patch_index, "identity_mismatch", requested_gid, prop, paste0(gid, " fingerprint does not match the R manifest object."), list(field = "fingerprint"))
      next
    }
    identity_rejected <- FALSE
    for (identity_field in if (is_legacy_target_alias) character() else c("semanticKey", "seriesKey")) {
      expected_identity <- identity_manifest_value(object$identity, identity_field)
      actual_identity <- identity_manifest_value(entry$identity, identity_field)
      if (present_manifest_value(actual_identity) && !identical(as.character(actual_identity), as.character(expected_identity %||% ""))) {
        reject_entry(requested_entry, patch_index, "identity_mismatch", requested_gid, prop, paste0(gid, " identity.", identity_field, " does not match the R manifest object."), list(field = paste0("identity.", identity_field)))
        identity_rejected <- TRUE
        break
      }
    }
    if (identity_rejected) next

    current_value <- object$currentProps[[effective_prop]]
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

restore_baseline_manifest_relations <- function(objects, baseline_manifest = NULL) {
  baseline_objects <- baseline_manifest$objects %||% list()
  if (length(objects) == 0 || length(baseline_objects) == 0) return(objects)
  baseline_by_id <- setNames(baseline_objects, vapply(
    baseline_objects,
    function(object) as.character(object$id %||% ""),
    character(1)
  ))
  relation_fields <- c("subplotId", "subplotIds", "layerIds", "groupIds", "guideKey")
  for (index in seq_along(objects)) {
    id <- as.character(objects[[index]]$id %||% "")
    baseline_object <- baseline_by_id[[id]] %||% NULL
    if (is.null(baseline_object)) next
    baseline_relation <- baseline_object$identity$relation %||% list()
    object_relation_fields <- relation_fields
    if (grepl("^r\\.guide\\.", id) && has_edit(id, "visible")) {
      # Hiding a guide removes its rendered items from ggplot's post-edit
      # catalog. Keep the pre-edit structural ownership so the same guide can
      # be shown again and its v2 identity does not drift with visibility.
      object_relation_fields <- unique(c(
        object_relation_fields,
        "scaleIds", "legendTextIds", "legendMarkerIds"
      ))
      for (field in c("parentId", "legendId", "guideKey", "guideType", "legendTitleId")) {
        value <- baseline_relation[[field]] %||% NULL
        if (!is.null(value)) objects[[index]][[field]] <- value
      }
    }
    for (field in object_relation_fields) {
      values <- r_manifest_string_values(baseline_relation[[field]])
      if (length(values) == 0) next
      objects[[index]][[field]] <- if (field %in% c("subplotId", "guideKey") && length(values) == 1) {
        values[[1]]
      } else {
        as.list(values)
      }
    }
  }

  current_ids <- vapply(objects, function(object) as.character(object$id %||% ""), character(1))
  hidden_guide_ids <- vapply(Filter(function(object) {
    id <- as.character(object$id %||% "")
    grepl("^r\\.guide\\.", id) &&
      has_edit(id, "visible") &&
      identical(object$currentProps$visible, FALSE)
  }, objects), function(object) as.character(object$id), character(1))
  for (guide_id in hidden_guide_ids) {
    baseline_guide <- baseline_by_id[[guide_id]] %||% NULL
    guide_relation <- baseline_guide$identity$relation %||% list()
    child_ids <- unique(c(
      r_manifest_string_values(guide_relation$legendTextIds),
      r_manifest_string_values(guide_relation$legendMarkerIds)
    ))
    for (child_id in child_ids) {
      if (child_id %in% current_ids) next
      baseline_child <- baseline_by_id[[child_id]] %||% NULL
      if (is.null(baseline_child)) next
      child <- baseline_child
      child_relation <- child$identity$relation %||% list()
      for (field in names(child_relation)) child[[field]] <- child_relation[[field]]
      for (prop in as.character(unlist(child$editable %||% list(), use.names = FALSE))) {
        if (has_edit(child_id, prop)) {
          child$currentProps[[prop]] <- latest_value(child_id, prop, child$currentProps[[prop]])
        }
      }
      child$currentProps$guideVisible <- FALSE
      child$currentProps$svgSelectable <- FALSE
      child$currentProps$hiddenByGuide <- guide_id
      child$identity <- NULL
      child$stableKey <- NULL
      child$fingerprint <- NULL
      child$fingerprintVersion <- NULL
      child$propertyCapabilities <- NULL
      objects[[length(objects) + 1L]] <- child
      current_ids <- c(current_ids, child_id)
    }
  }
  objects
}

restore_baseline_scale_semantics <- function(scale_semantics, baseline_manifest = NULL) {
  baseline_groups <- baseline_manifest$groups %||% list()
  if (length(baseline_groups) == 0) return(scale_semantics)
  append_missing_by_id <- function(current, baseline, id_field) {
    current <- current %||% list()
    current_ids <- vapply(current, function(item) as.character(item[[id_field]] %||% ""), character(1))
    for (item in baseline %||% list()) {
      item_id <- as.character(item[[id_field]] %||% "")
      if (nzchar(item_id) && !item_id %in% current_ids) {
        current[[length(current) + 1]] <- item
        current_ids <- c(current_ids, item_id)
      }
    }
    current
  }

  baseline_group_ids <- vapply(baseline_groups, function(group) as.character(group$groupId %||% ""), character(1))
  baseline_group_objects <- Filter(function(object) {
    as.character(object$id %||% "") %in% baseline_group_ids
  }, baseline_manifest$objects %||% list())

  group_match_key <- function(group = NULL, object = NULL) {
    relation <- object$identity$relation %||% list()
    aesthetic <- as.character(
      object$currentProps$aesthetic %||%
        object$aesthetic %||%
        relation$aesthetic %||%
        group$aesthetic %||%
        ""
    )
    scale_id <- as.character(
      object$scaleId %||%
        relation$scaleId %||%
        group$scaleId %||%
        ""
    )
    group_key <- as.character(
      object$currentProps$groupKey %||%
        object$groupKey %||%
        relation$groupKey %||%
        group$label %||%
        ""
    )
    if (!nzchar(aesthetic) || !nzchar(scale_id) || !nzchar(group_key)) return("")
    paste(aesthetic, scale_id, group_key, sep = "\u001f")
  }

  baseline_object_by_id <- setNames(baseline_group_objects, vapply(
    baseline_group_objects,
    function(object) as.character(object$id %||% ""),
    character(1)
  ))
  keyed_values <- function(index, key, value) {
    if (!nzchar(key)) return(index)
    index[[key]] <- c(index[[key]] %||% list(), list(value))
    index
  }

  baseline_targets_by_key <- list()
  for (group in baseline_groups) {
    group_id <- as.character(group$groupId %||% "")
    object <- baseline_object_by_id[[group_id]] %||% NULL
    key <- group_match_key(group, object)
    if (nzchar(key) && nzchar(group_id)) {
      baseline_targets_by_key <- keyed_values(baseline_targets_by_key, key, list(
        groupId = group_id,
        paletteId = as.character(group$paletteId %||% "")
      ))
    }
  }

  current_object_by_id <- setNames(scale_semantics$objects %||% list(), vapply(
    scale_semantics$objects %||% list(),
    function(object) as.character(object$id %||% ""),
    character(1)
  ))
  current_groups_by_key <- list()
  for (group in scale_semantics$groups %||% list()) {
    current_group_id <- as.character(group$groupId %||% "")
    current_object <- current_object_by_id[[current_group_id]] %||% NULL
    key <- group_match_key(group, current_object)
    if (nzchar(key) && nzchar(current_group_id)) {
      current_groups_by_key <- keyed_values(current_groups_by_key, key, list(
        groupId = current_group_id,
        paletteId = as.character(group$paletteId %||% "")
      ))
    }
  }

  # Only reuse a baseline identity when the structural key resolves to exactly
  # one current group and one baseline group. Ambiguous keys are left on their
  # renderer-generated IDs so repeated labels cannot collapse distinct targets.
  remap_candidates <- list()
  shared_keys <- intersect(names(baseline_targets_by_key), names(current_groups_by_key))
  for (key in shared_keys) {
    baseline_candidates <- baseline_targets_by_key[[key]] %||% list()
    current_candidates <- current_groups_by_key[[key]] %||% list()
    if (length(baseline_candidates) != 1L || length(current_candidates) != 1L) next
    remap_candidates[[length(remap_candidates) + 1L]] <- list(
      source = current_candidates[[1]],
      target = baseline_candidates[[1]]
    )
  }

  candidate_target_group_ids <- vapply(
    remap_candidates,
    function(candidate) as.character(candidate$target$groupId %||% ""),
    character(1)
  )
  candidate_target_palette_ids <- vapply(
    remap_candidates,
    function(candidate) as.character(candidate$target$paletteId %||% ""),
    character(1)
  )
  candidate_source_group_ids <- vapply(
    remap_candidates,
    function(candidate) as.character(candidate$source$groupId %||% ""),
    character(1)
  )
  current_group_ids_before_remap <- vapply(
    scale_semantics$groups %||% list(),
    function(group) as.character(group$groupId %||% ""),
    character(1)
  )
  current_palette_ids_before_remap <- vapply(
    scale_semantics$groups %||% list(),
    function(group) as.character(group$paletteId %||% ""),
    character(1)
  )
  target_group_counts <- table(candidate_target_group_ids[nzchar(candidate_target_group_ids)])
  target_palette_counts <- table(candidate_target_palette_ids[nzchar(candidate_target_palette_ids)])
  source_group_counts <- table(candidate_source_group_ids[nzchar(candidate_source_group_ids)])

  group_id_remap <- list()
  palette_id_remap <- list()
  for (candidate in remap_candidates) {
    source_group_id <- as.character(candidate$source$groupId %||% "")
    target_group_id <- as.character(candidate$target$groupId %||% "")
    source_palette_id <- as.character(candidate$source$paletteId %||% "")
    target_palette_id <- as.character(candidate$target$paletteId %||% "")
    if (!nzchar(source_group_id) || !nzchar(target_group_id)) next
    if (as.integer(source_group_counts[[source_group_id]] %||% 0L) != 1L) next
    if (as.integer(target_group_counts[[target_group_id]] %||% 0L) != 1L) next
    # Do not perform a swap or overwrite a currently occupied identity. A
    # conservative no-remap is safer than silently changing a group target.
    if (!identical(source_group_id, target_group_id) && target_group_id %in% current_group_ids_before_remap) next
    if (nzchar(source_palette_id) && nzchar(target_palette_id)) {
      if (as.integer(target_palette_counts[[target_palette_id]] %||% 0L) != 1L) next
      if (!identical(source_palette_id, target_palette_id) && target_palette_id %in% current_palette_ids_before_remap) next
      palette_id_remap[[source_palette_id]] <- target_palette_id
    }
    group_id_remap[[source_group_id]] <- target_group_id
  }

  remap_id <- function(value, mapping) {
    text <- as.character(value %||% "")
    as.character(mapping[[text]] %||% text)
  }
  scale_semantics$groups <- lapply(scale_semantics$groups %||% list(), function(group) {
    group$groupId <- remap_id(group$groupId, group_id_remap)
    group$paletteId <- remap_id(group$paletteId, palette_id_remap)
    group
  })
  scale_semantics$objects <- lapply(scale_semantics$objects %||% list(), function(object) {
    object$id <- remap_id(object$id, group_id_remap)
    object
  })
  scale_semantics$palettes <- lapply(scale_semantics$palettes %||% list(), function(palette) {
    palette$id <- remap_id(palette$id, palette_id_remap)
    palette
  })
  scale_semantics$bindings <- lapply(scale_semantics$bindings %||% list(), function(binding) {
    binding$groupId <- remap_id(binding$groupId, group_id_remap)
    binding$paletteId <- remap_id(binding$paletteId, palette_id_remap)
    binding$gids <- as.list(vapply(
      binding$gids %||% list(),
      function(gid) remap_id(gid, group_id_remap),
      character(1)
    ))
    binding$targets <- lapply(binding$targets %||% list(), function(target) {
      target$gid <- remap_id(target$gid, group_id_remap)
      if (nzchar(target$gid)) {
        target$instanceKey <- paste("r", "container", target$gid, sep = ":")
      }
      target
    })
    binding
  })

  current_group_object_ids <- vapply(
    scale_semantics$objects %||% list(),
    function(object) as.character(object$id %||% ""),
    character(1)
  )
  scale_semantics$groups <- append_missing_by_id(scale_semantics$groups, baseline_groups, "groupId")
  scale_semantics$objects <- append_missing_by_id(scale_semantics$objects, baseline_group_objects, "id")
  scale_semantics$palettes <- append_missing_by_id(scale_semantics$palettes, baseline_manifest$palettes %||% list(), "id")
  scale_semantics$bindings <- append_missing_by_id(scale_semantics$bindings, baseline_manifest$bindings %||% list(), "groupId")

  assert_unique_ids <- function(items, field, label) {
    values <- vapply(items %||% list(), function(item) as.character(item[[field]] %||% ""), character(1))
    values <- values[nzchar(values)]
    duplicates <- unique(values[duplicated(values)])
    if (length(duplicates) > 0) {
      stop(sprintf("Duplicate %s after discrete scale identity remap: %s", label, paste(duplicates, collapse = ", ")))
    }
  }
  assert_unique_ids(scale_semantics$groups, "groupId", "groupId")
  assert_unique_ids(scale_semantics$objects, "id", "object id")
  assert_unique_ids(scale_semantics$palettes, "id", "palette id")
  assert_unique_ids(scale_semantics$bindings, "groupId", "binding groupId")
  assert_unique_ids(scale_semantics$bindings, "paletteId", "binding paletteId")
  target_instance_keys <- unlist(lapply(
    scale_semantics$bindings %||% list(),
    function(binding) vapply(binding$targets %||% list(), function(target) as.character(target$instanceKey %||% ""), character(1))
  ), use.names = FALSE)
  target_instance_keys <- target_instance_keys[nzchar(target_instance_keys)]
  duplicate_instance_keys <- unique(target_instance_keys[duplicated(target_instance_keys)])
  if (length(duplicate_instance_keys) > 0) {
    stop(sprintf(
      "Duplicate discrete scale binding target instanceKey after remap: %s",
      paste(duplicate_instance_keys, collapse = ", ")
    ))
  }

  baseline_by_id <- setNames(baseline_groups, vapply(
    baseline_groups,
    function(group) as.character(group$groupId %||% ""),
    character(1)
  ))
  object_index_by_id <- setNames(seq_along(scale_semantics$objects %||% list()), vapply(
    scale_semantics$objects %||% list(),
    function(object) as.character(object$id %||% ""),
    character(1)
  ))
  for (index in seq_along(scale_semantics$groups)) {
    group_id <- as.character(scale_semantics$groups[[index]]$groupId %||% "")
    baseline_group <- baseline_by_id[[group_id]] %||% NULL
    if (is.null(baseline_group)) next
    for (field in c("kind", "geomFamilies", "layerIds", "subplotIds")) {
      if (!is.null(baseline_group[[field]])) {
        scale_semantics$groups[[index]][[field]] <- baseline_group[[field]]
      }
    }
    object_index <- object_index_by_id[[group_id]] %||% NULL
    if (is.null(object_index)) next
    baseline_object <- baseline_object_by_id[[group_id]] %||% NULL
    baseline_relation <- baseline_object$identity$relation %||% list()
    for (field in c("kind", "role")) {
      if (!is.null(baseline_object[[field]])) {
        scale_semantics$objects[[object_index]][[field]] <- baseline_object[[field]]
      }
    }
    baseline_artist_class <- baseline_object$source$artistClass %||% NULL
    if (!is.null(baseline_artist_class)) {
      scale_semantics$objects[[object_index]]$source$artistClass <- baseline_artist_class
    }
    for (field in c("scaleId", "scaleKey", "guideId", "guideKey", "legendId", "aesthetic", "groupKey")) {
      value <- baseline_relation[[field]] %||% baseline_object[[field]] %||% NULL
      if (!is.null(value)) scale_semantics$objects[[object_index]][[field]] <- value
    }
    if (!group_id %in% current_group_object_ids) {
      scale_semantics$objects[[object_index]]$currentProps$scaleActive <- FALSE
    }
    scale_semantics$objects[[object_index]]$layerIds <- baseline_group$layerIds %||% scale_semantics$objects[[object_index]]$layerIds
    scale_semantics$objects[[object_index]]$subplotIds <- baseline_group$subplotIds %||% scale_semantics$objects[[object_index]]$subplotIds
    scale_semantics$objects[[object_index]]$currentProps$semanticKind <- baseline_group$kind %||% scale_semantics$objects[[object_index]]$currentProps$semanticKind
    scale_semantics$objects[[object_index]]$currentProps$geomFamilies <- baseline_group$geomFamilies %||% scale_semantics$objects[[object_index]]$currentProps$geomFamilies
    color_prop <- if (identical(as.character(baseline_group$aesthetic %||% ""), "fill")) "facecolor" else "color"
    fallback_color <- scale_semantics$objects[[object_index]]$currentProps[[color_prop]] %||% "#000000"
    resolved_color <- latest_string(group_id, color_prop, fallback_color)
    scale_semantics$objects[[object_index]]$currentProps[[color_prop]] <- resolved_color
    palette_id <- as.character(baseline_group$paletteId %||% "")
    for (palette_index in seq_along(scale_semantics$palettes %||% list())) {
      if (identical(as.character(scale_semantics$palettes[[palette_index]]$id %||% ""), palette_id)) {
        scale_semantics$palettes[[palette_index]]$color <- resolved_color
        break
      }
    }
  }
  scale_semantics
}

build_ggplot_manifest <- function(plot_obj, svg = "", baseline_manifest = NULL) {
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
  objects <- c(objects, manifest_legend_key_objects(plot_obj))
  objects <- c(objects, manifest_discrete_guide_objects(plot_obj))
  
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
    layer_build <- tryCatch(ggplot2::ggplot_build(plot_obj), error = function(e) NULL)
    layer_built_data <- layer_build$data %||% list()
    layer_objects <- lapply(
      seq_along(plot_obj$layers),
      function(i) manifest_layer_object(
        plot_obj$layers[[i]],
        i,
        plot_obj$mapping,
        if (length(layer_built_data) >= i) layer_built_data[[i]] else NULL
      )
    )
    objects <- c(objects, layer_objects)
    objects <- c(objects, manifest_segment_curve_arrow_objects(plot_obj, layer_built_data))
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
    facet_layout_object <- manifest_facet_layout_object(plot_obj)
    if (!is.null(facet_layout_object)) {
      objects <- c(objects, list(facet_layout_object))
    }
    objects <- c(objects, facet_objects)
    strip_object <- manifest_facet_strip_object(plot_obj)
    if (!is.null(strip_object)) {
      objects <- c(objects, list(strip_object))
    }
  }
  built_plot <- tryCatch(ggplot2::ggplot_build(plot_obj)$plot, error = function(e) plot_obj)
  scale_semantics <- restore_baseline_scale_semantics(
    detect_discrete_scale_semantics(built_plot),
    baseline_manifest
  )
  if (length(scale_semantics$objects) > 0) {
    objects <- c(objects, scale_semantics$objects)
  }
  if (length(scale_semantics$objects) > 0) {
    scale_group_objects <- Filter(
      function(group_obj) grepl("^r\\.group\\.", as.character(group_obj$id %||% "")),
      scale_semantics$objects
    )
    for (object_index in seq_along(objects)) {
      object_id <- as.character(objects[[object_index]]$id %||% "")
      if (grepl("^r\\.layer\\.", object_id)) {
        linked_groups <- Filter(function(group_obj) object_id %in% unlist(group_obj$layerIds %||% list()), scale_group_objects)
        if (length(linked_groups) > 0) {
          objects[[object_index]]$groupIds <- as.list(vapply(linked_groups, function(group_obj) group_obj$id, character(1)))
          objects[[object_index]]$subplotIds <- as.list(unique(unlist(lapply(linked_groups, function(group_obj) group_obj$subplotIds %||% list()))))
        }
      } else if (identical(object_id, "legend.0")) {
        objects[[object_index]]$groupIds <- as.list(vapply(scale_group_objects, function(group_obj) group_obj$id, character(1)))
      }
    }
  }
  objects <- restore_baseline_manifest_relations(objects, baseline_manifest)
  continuous_colorbar_objects <- manifest_continuous_colorbar_objects(plot_obj, layout_bounds)
  objects <- link_family8_continuous_relations(objects, continuous_colorbar_objects)
  if (length(continuous_colorbar_objects) > 0) {
    objects <- c(objects, continuous_colorbar_objects)
  }

  assert_unique_r_diagram_gids(objects)
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
  coordinate_support <- text_position_support(plot_obj)
  coordinate_diagnostics <- if (
    length(text_layer_objects) > 0 && !isTRUE(coordinate_support$supported)
  ) {
    list(list(
      capability = "text.position",
      class = coordinate_support$coordinateClass %||% "unknown",
      adapter = coordinate_support$adapter %||% "unknown",
      status = coordinate_support$status %||% "shadow_unsupported",
      reason = coordinate_support$reason %||% "No verified inverse coordinate adapter is available."
    ))
  } else {
    list()
  }

  kind_counts <- table(vapply(objects, function(obj) obj$kind, character(1)))
  kind_count <- function(kind) {
    if (!kind %in% names(kind_counts)) return(0L)
    as.integer(kind_counts[[kind]])
  }
  kind_editable_props <- function(kind, fallback = list()) {
    matching <- Filter(function(obj) identical(as.character(obj$kind %||% ""), kind), objects)
    if (length(matching) == 0) return(fallback)
    as.list(unique(unlist(lapply(matching, function(obj) obj$editable %||% list()), use.names = FALSE)))
  }
  by_kind <- list(
    text = list(
      count = kind_count("text"),
      editableProps = kind_editable_props(
        "text",
        list("text", "fontsize", "fontfamily", "fontweight", "fontstyle", "color", "hjust", "vjust", "rotation", "lineheight", "position")
      )
    ),
    axis_x = list(count = kind_count("axis_x"), editableProps = list("label", "label_fontsize", "label_color", "tick_labelsize", "tick_labelfamily", "tick_labelcolor", "tick_fontweight", "tick_fontstyle", "limits", "tick_rotation", "tick_direction", "tick_length", "tick_width", "tick_color", "tick_pad")),
    axis_y = list(count = kind_count("axis_y"), editableProps = list("label", "label_fontsize", "label_color", "tick_labelsize", "tick_labelfamily", "tick_labelcolor", "tick_fontweight", "tick_fontstyle", "limits", "tick_rotation", "tick_direction", "tick_length", "tick_width", "tick_color", "tick_pad")),
    legend = list(count = kind_count("legend"), editableProps = list("title", "fontsize", "fontfamily", "fontweight", "fontstyle", "color", "visible", "loc", "ncol", "markerscale", "handletextpad", "labelspacing", "columnspacing", "borderpad", "facecolor", "edgecolor", "linewidth", "alpha")),
    collection = list(count = kind_count("collection"), editableProps = list("color", "facecolor", "edgecolor", "linewidth", "size", "size_scale", "marker", "alpha")),
    line = list(count = kind_count("line"), editableProps = list("color", "linewidth", "linestyle", "alpha")),
    patch = list(count = kind_count("patch"), editableProps = kind_editable_props("patch", list("facecolor", "edgecolor", "linewidth", "alpha"))),
    contour = list(count = kind_count("contour"), editableProps = kind_editable_props("contour", list("color", "linewidth", "linestyle", "alpha"))),
    contourf = list(count = kind_count("contourf"), editableProps = kind_editable_props("contourf", list("facecolor", "edgecolor", "linewidth", "linestyle", "alpha"))),
    errorbar_container = list(count = kind_count("errorbar_container"), editableProps = list("color", "elinewidth", "linestyle", "alpha", "capsize", "marker", "markersize", "facecolor")),
    boxplot_container = list(count = kind_count("boxplot_container"), editableProps = kind_editable_props("boxplot_container", list("color", "linewidth", "alpha", "box_color", "outlier_color", "outlier_shape", "outlier_size", "outlier_stroke", "outlier_alpha"))),
    violinplot_container = list(count = kind_count("violinplot_container"), editableProps = kind_editable_props("violinplot_container", list("facecolor", "edgecolor", "linewidth", "alpha"))),
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
      unsupportedArtists = unsupported_artists,
      coordinateDiagnostics = coordinate_diagnostics
    ),
    unsupportedNotes = list(
      "R ggplot2 semantic editing currently covers labels, theme text, Point/Jitter, Line/Path/Smooth, Bar/Col, Errorbar/Linerange/Pointrange/Crossbar, Boxplot/Violin, Ribbon/Area, Step/Histogram/Freqpoly, Tile/Raster/Rect, Contour/ContourFilled, and explicitly marked network/path/SEM diagram objects, plus manual color/fill scales, facet panel discovery, and continuous heatmap/colorbar scales.",
      "Network/path/SEM objects require explicit scifigure-sem-v1 markers with stable node and edge relations. Unmarked lookalike points, lines, arrows, and text remain generic; coefficients, p values, fit metrics, and topology stay readonly.",
      "Duplicate keys within one discrete color/fill scale are reported as ambiguous readonly groups; SciFigure will not guess which repeated key a palette edit should target.",
      "R facet subplot aspect uses ggplot theme(aspect.ratio); independent left/bottom/width/height panel bounds are not equivalent to Matplotlib axes bounds.",
      "Text drag-position replay is enabled only for verified Cartesian, fixed, flip, log-scale, and polar adapters; projected, nonlinear, and third-party coordinates remain explicitly readonly."
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
  env$scifigure_semantic_layer <- scifigure_semantic_layer
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

  baseline_manifest <- NULL
  script_execution_started_ms <- monotonic_ms()
  withCallingHandlers({
    eval(parse(text = script), envir = env)
    candidate_names <- c("p", "plot_obj", "figure", "fig")
    for (name in candidate_names) {
      if (exists(name, envir = env, inherits = FALSE)) {
        obj <- get(name, envir = env)
        if (inherits(obj, "ggplot")) {
          obj <- r_expand_scifigure_semantic_layers(obj)
          assign(name, obj, envir = env)
          source_entries <- edit_entries
          source_patch_warnings <- renderer_patch_warnings
          edit_entries <- list()
          baseline_manifest <- build_ggplot_manifest(obj, "")
          edit_entries <- source_entries
          renderer_patch_warnings <- source_patch_warnings
          r_edit_resolution <- resolve_r_edit_entries(baseline_manifest, source_entries)
          r_edit_resolution <- validate_r_diagram_edit_resolution(baseline_manifest, r_edit_resolution)
          if (length(r_edit_resolution$rejected %||% list()) > 0) {
            r_edit_resolution$accepted <- list()
            r_edit_resolution$rejected <- source_entries
          }
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
    build_ggplot_manifest(ggplot_obj, svg, baseline_manifest)
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
    svg <- inject_svg_text_ids(svg, manifest, ggplot_obj)
    svg <- apply_svg_legend_text_edits(svg, manifest)
    svg <- apply_svg_text_style_edits(svg, manifest)
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
