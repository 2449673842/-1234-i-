suppressWarnings({
  if (!requireNamespace("jsonlite", quietly = TRUE)) {
    cat('{"status":"error","message":"R dependency missing: jsonlite. Please install it with install.packages(\\"jsonlite\\")."}')
    quit(status = 0)
  }
})

args <- commandArgs(trailingOnly = TRUE)
payload_file <- NULL
for (i in seq_along(args)) {
  if (args[[i]] == "--payload-file" && i < length(args)) {
    payload_file <- args[[i + 1]]
  }
}

if (is.null(payload_file) || !file.exists(payload_file)) {
  cat(jsonlite::toJSON(list(status = "error", message = "payload file is required"), auto_unbox = TRUE))
  quit(status = 0)
}

payload <- jsonlite::fromJSON(payload_file, simplifyVector = TRUE)
script <- payload$script
if (is.null(script) || !nzchar(script)) {
  cat(jsonlite::toJSON(list(status = "error", message = "R script is required"), auto_unbox = TRUE))
  quit(status = 0)
}

render_options <- payload$renderOptions
width <- 7
height <- 5
if (!is.null(render_options$width_in)) width <- as.numeric(render_options$width_in)
if (!is.null(render_options$height_in)) height <- as.numeric(render_options$height_in)

tmp_svg <- tempfile(fileext = ".svg")
warnings_collected <- character()

add_warning_once <- function(message) {
  warnings_collected <<- unique(c(warnings_collected, message))
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

edit_entries <- as_edit_entries(payload$editLog)

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
  markerscale = 1.0
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
  if (geom %in% c("GeomLine", "GeomPath", "GeomSmooth", "GeomSegment", "GeomCurve")) return("line")
  if (geom %in% c("GeomBoxplot")) return("boxplot_container")
  if (geom %in% c("GeomViolin")) return("violinplot_container")
  if (geom %in% c("GeomCol", "GeomBar", "GeomTile", "GeomRect")) return("patch")
  if (geom %in% c("GeomErrorbar", "GeomErrorbarh", "GeomPointrange", "GeomLinerange", "GeomCrossbar")) return("errorbar_container")
  "container"
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
    for (row_index in seq_len(nrow(data))) {
      rows[[length(rows) + 1]] <- list(
        layerIndex = i,
        rowIndex = row_index,
        geom = geom,
        data = data[row_index, , drop = FALSE]
      )
    }
  }
  rows
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

text_position_support <- function(plot_obj) {
  coord_classes <- class(plot_obj$coordinates %||% NULL)
  unsafe_coord <- intersect(coord_classes, c("CoordFlip", "CoordPolar", "CoordTrans", "CoordSf", "CoordMap", "CoordQuickmap"))
  if (length(unsafe_coord) > 0) {
    return(list(
      supported = FALSE,
      reason = paste0("Text dragging disabled for ggplot coordinate system: ", unsafe_coord[[1]])
    ))
  }

  scales <- plot_obj$scales$scales %||% list()
  if (length(scales) > 0) {
    for (scale_obj in scales) {
      if (!is_position_scale(scale_obj)) next
      trans_name <- NULL
      if (!is.null(scale_obj$trans) && !is.null(scale_obj$trans$name)) {
        trans_name <- as.character(scale_obj$trans$name)
      }
      if (is.null(trans_name) || length(trans_name) == 0) next
      if (!trans_name %in% c("identity", "none")) {
        return(list(
          supported = FALSE,
          reason = paste0("Text dragging disabled for transformed ggplot position scale: ", trans_name)
        ))
      }
    }
  }

  list(supported = TRUE, reason = NULL)
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
  ranges <- panel_ranges(plot_obj)
  position_support <- text_position_support(plot_obj)

  edited_by_layer <- list()
  for (item in rows) {
    gid <- paste0("r.text.", item$layerIndex - 1, ".", item$rowIndex - 1)
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
      edited_by_layer[[layer_key]] <- ggplot2::ggplot_build(plot_obj)$data[[item$layerIndex]]
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
        add_warning_once(position_support$reason %||% "Text position patch ignored for unsupported ggplot coordinate system.")
      } else {
        pos <- extract_position_value(latest_value(gid, "position", NULL))
        if (!is.null(pos)) {
          next_x <- pos$x
          next_y <- pos$y
          coord_system <- pos$coord_system
          if (coord_system == "axes") {
            panel <- as.character(row$PANEL %||% 1)
            converted <- from_axes_fraction(next_x, next_y, ranges[[panel]])
            next_x <- converted$x
            next_y <- converted$y
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
    geom <- geom_class(plot_obj$layers[[layer_index]])
    layer_data <- edited_by_layer[[layer_key]]
    keep_cols <- intersect(
      c("x", "y", "label", "colour", "color", "size", "alpha", "family", "fontface", "angle", "hjust", "vjust", "lineheight"),
      names(layer_data)
    )
    layer_data <- layer_data[, keep_cols, drop = FALSE]
    names(layer_data)[names(layer_data) == "colour"] <- "colour"
    if (geom == "GeomLabel") {
      plot_obj$layers[[layer_index]] <- ggplot2::geom_label(
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
      plot_obj$layers[[layer_index]] <- ggplot2::geom_text(
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
  }

  plot_obj
}

manual_scale_values <- function(scale_obj) {
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

detect_manual_palettes <- function(plot_obj) {
  palettes <- list()
  bindings <- list()
  groups <- list()
  objects <- list()
  if (is.null(plot_obj$scales) || length(plot_obj$scales$scales) == 0) {
    return(list(palettes = palettes, bindings = bindings, groups = groups, objects = objects))
  }

  for (scale_index in seq_along(plot_obj$scales$scales)) {
    scale_obj <- plot_obj$scales$scales[[scale_index]]
    kind <- scale_kind(scale_obj)
    if (is.null(kind)) next
    values <- manual_scale_values(scale_obj)
    if (is.null(values)) next
    labels <- names(values)
    if (is.null(labels) || any(!nzchar(labels))) {
      labels <- paste0(kind, "_", seq_along(values))
    }

    for (i in seq_along(values)) {
      palette_id <- paste0("r.scale.", kind, ".", scale_index - 1, ".", i - 1)
      group_id <- paste0("r.group.", kind, ".", scale_index - 1, ".", i - 1)
      color <- as.character(values[[i]])
      label <- as.character(labels[[i]])
      palettes[[length(palettes) + 1]] <- list(
        id = palette_id,
        label = label,
        color = latest_string(group_id, if (kind == "fill") "facecolor" else "color", color),
        source = paste0("ggplot scale_", kind, "_manual"),
        line = 0
      )
      groups[[length(groups) + 1]] <- list(
        groupId = group_id,
        label = label,
        paletteId = palette_id,
        kind = if (kind == "fill") "bar" else "scatter"
      )
      objects[[length(objects) + 1]] <- list(
        id = group_id,
        kind = if (kind == "fill") "patch" else "collection",
        label = paste0(label, " (", kind, " scale)"),
        editable = list(if (kind == "fill") "facecolor" else "color"),
        currentProps = if (kind == "fill") list(facecolor = latest_string(group_id, "facecolor", color)) else list(color = latest_string(group_id, "color", color)),
        role = paste0("ggplot_scale_", kind),
        source = list(artistClass = "ggplot_scale_manual", axesIndex = 0)
      )
      bindings[[length(bindings) + 1]] <- list(
        paletteId = palette_id,
        groupId = group_id,
        gids = list(group_id),
        props = list(if (kind == "fill") "facecolor" else "color")
      )
    }
  }
  list(palettes = palettes, bindings = bindings, groups = groups, objects = objects)
}

apply_manual_scale_edits <- function(plot_obj) {
  if (is.null(plot_obj$scales) || length(plot_obj$scales$scales) == 0) return(plot_obj)

  for (scale_index in seq_along(plot_obj$scales$scales)) {
    scale_obj <- plot_obj$scales$scales[[scale_index]]
    kind <- scale_kind(scale_obj)
    if (is.null(kind)) next
    values <- manual_scale_values(scale_obj)
    if (is.null(values)) next
    labels <- names(values)
    if (is.null(labels) || any(!nzchar(labels))) {
      labels <- paste0(kind, "_", seq_along(values))
    }
    changed <- FALSE
    for (i in seq_along(values)) {
      group_id <- paste0("r.group.", kind, ".", scale_index - 1, ".", i - 1)
      prop <- if (kind == "fill") "facecolor" else "color"
      if (has_edit(group_id, prop)) {
        values[[i]] <- latest_string(group_id, prop, as.character(values[[i]]))
        changed <- TRUE
      }
    }
    if (changed) {
      names(values) <- labels
      if (kind == "fill") {
        plot_obj <- suppressMessages(plot_obj + ggplot2::scale_fill_manual(values = values))
      } else {
        plot_obj <- suppressMessages(plot_obj + ggplot2::scale_color_manual(values = values))
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
    colorbar_changed <- has_edit(colorbar_gid, "label") ||
      has_edit(colorbar_gid, "tick_fontsize") ||
      has_edit(colorbar_gid, "visible") ||
      has_edit(colorbar_gid, "left") ||
      has_edit(colorbar_gid, "bottom") ||
      has_edit(colorbar_gid, "width") ||
      has_edit(colorbar_gid, "height")

    if (scale_changed || colorbar_changed) {
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
      left <- clamp_numeric(latest_numeric(colorbar_gid, "left", default_colorbar$left), 0, 1)
      bottom <- clamp_numeric(latest_numeric(colorbar_gid, "bottom", default_colorbar$bottom), 0, 1)
      width <- clamp_numeric(latest_numeric(colorbar_gid, "width", default_colorbar$width), 0.01, 1)
      height <- clamp_numeric(latest_numeric(colorbar_gid, "height", default_colorbar$height), 0.01, 1)
      guide <- ggplot2::guide_colourbar(
        barwidth = ggplot2::unit(width, "npc"),
        barheight = ggplot2::unit(height, "npc")
      )
      if (kind == "fill") {
        plot_obj <- plot_obj + ggplot2::guides(fill = guide)
      } else {
        plot_obj <- plot_obj + ggplot2::guides(color = guide, colour = guide)
      }
      plot_obj <- plot_obj + ggplot2::theme(
        legend.position = c(left, bottom),
        legend.justification = c(0, 0)
      )
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
  if (is.null(plot_obj$scales) || length(plot_obj$scales$scales) == 0) return(plot_obj)

  label_index <- 0L
  for (scale_index in seq_along(plot_obj$scales$scales)) {
    scale_obj <- plot_obj$scales$scales[[scale_index]]
    kind <- scale_kind(scale_obj)
    if (is.null(kind) || is_continuous_colour_scale(scale_obj)) next

    labels <- NULL
    if (!is.null(scale_obj$get_labels)) {
      labels <- tryCatch(scale_obj$get_labels(), error = function(e) NULL)
    }
    if (is.null(labels) || length(labels) == 0) {
      labels <- scale_obj$labels
    }
    if (is.null(labels) || length(labels) == 0) {
      labels <- scale_obj$range$range
    }
    labels <- as.character(labels %||% character())
    if (length(labels) == 0) next

    changed <- FALSE
    next_labels <- labels
    for (i in seq_along(next_labels)) {
      gid <- paste0("legend_text.0.", label_index)
      if (has_edit(gid, "text")) {
        next_labels[[i]] <- latest_string(gid, "text", next_labels[[i]])
        changed <- TRUE
      }
      label_index <- label_index + 1L
    }
    if (changed) {
      scale_name <- scale_obj$name %||% plot_obj$labels[[kind]] %||% ggplot2::waiver()
      values <- manual_scale_values(scale_obj)
      if (!is.null(values)) {
        breaks <- names(values)
        if (is.null(breaks) || any(!nzchar(breaks))) {
          breaks <- labels
        }
        if (length(breaks) == length(next_labels)) {
          names(next_labels) <- breaks
        }
        if (kind == "fill") {
          plot_obj <- suppressMessages(plot_obj + ggplot2::scale_fill_manual(values = values, breaks = breaks, labels = next_labels, name = scale_name))
        } else {
          plot_obj <- suppressMessages(plot_obj + ggplot2::scale_colour_manual(values = values, breaks = breaks, labels = next_labels, name = scale_name))
        }
      } else {
        if (kind == "fill") {
          plot_obj <- suppressMessages(plot_obj + ggplot2::scale_fill_discrete(labels = next_labels, name = scale_name))
        } else {
          plot_obj <- suppressMessages(plot_obj + ggplot2::scale_colour_discrete(labels = next_labels, name = scale_name))
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
  legend_title <- latest_string(
    "legend_title.0",
    "text",
    latest_string("legend.0", "title", plot_obj$labels$colour %||% plot_obj$labels$color %||% plot_obj$labels$fill %||% "")
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
        face = legend_item_style$face
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

  if (has_edit("legend.0", "ncol") || has_edit("legend.0", "markerscale")) {
    continuous_kinds <- unique(vapply(find_continuous_colour_scales(plot_obj), function(item) item$kind, character(1)))
    guide <- ggplot2::guide_legend(
      ncol = legend_ncol,
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

  plot_obj <- apply_manual_scale_edits(plot_obj)
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

legend_item_labels <- function(plot_obj) {
  built <- tryCatch(ggplot2::ggplot_build(plot_obj), error = function(e) NULL)
  scale_list <- NULL
  if (!is.null(built) && !is.null(built$plot) && !is.null(built$plot$scales)) {
    scale_list <- built$plot$scales$scales
  }
  if (is.null(scale_list)) {
    scale_list <- plot_obj$scales$scales %||% list()
  }
  if (length(scale_list) == 0) return(character())

  labels <- character()
  for (scale_obj in scale_list) {
    kind <- scale_kind(scale_obj)
    if (is.null(kind) || is_continuous_colour_scale(scale_obj)) next

    scale_labels <- NULL
    if (!is.null(scale_obj$get_labels)) {
      scale_labels <- tryCatch(scale_obj$get_labels(), error = function(e) NULL)
    }
    if (is.null(scale_labels) || length(scale_labels) == 0) {
      scale_labels <- scale_obj$labels
    }
    if (is.null(scale_labels) || length(scale_labels) == 0) {
      scale_labels <- scale_obj$range$range
    }
    scale_labels <- as.character(scale_labels %||% character())
    scale_labels <- scale_labels[!is.na(scale_labels) & nzchar(scale_labels)]
    labels <- c(labels, scale_labels)
  }
  unique(labels)
}

manifest_legend_text_objects <- function(plot_obj, legend_title, legend_style) {
  objects <- list()
  title_style <- style_for_gid("legend_title.0", legend_style)
  if (nzchar(legend_title)) {
    objects[[length(objects) + 1]] <- manifest_text_object("legend_title.0", "legend_title", legend_title, title_style)
    objects[[length(objects)]]$role <- "legend_title"
    objects[[length(objects)]]$source <- list(artistClass = "ggplot_legend_title", axesIndex = 0)
  }

  labels <- legend_item_labels(plot_obj)
  if (length(labels) == 0) return(objects)
  for (i in seq_along(labels)) {
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
    obj <- manifest_text_object(gid, "legend_text", latest_string(gid, "text", labels[[i]]), style)
    obj$currentProps$originalText <- labels[[i]]
    obj$editable <- list("text", "fontsize", "fontfamily", "fontweight", "fontstyle", "color")
    obj$role <- "legend_text"
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

manifest_layer_object <- function(layer, index) {
  geom <- geom_class(layer)
  gid <- paste0("r.layer.", index - 1)
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
    list("color", "linewidth", "alpha")
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
    list(color = props$color, linewidth = props$linewidth, alpha = props$alpha)
  )
  list(
    id = gid,
    kind = kind,
    label = layer_label(geom, index),
    editable = editable,
    currentProps = current_props,
    role = paste0("ggplot_", geom),
    source = list(artistClass = geom, axesIndex = 0, zorder = index)
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
  position_support <- text_position_support(plot_obj)

  lapply(rows, function(item) {
    data <- item$data
    gid <- paste0("r.text.", item$layerIndex - 1, ".", item$rowIndex - 1)
    panel <- as.integer(data$PANEL %||% 1)
    range <- ranges[[as.character(panel)]]
    frac <- to_axes_fraction(data$x, data$y, range)
    pos <- latest_axes_position(gid, frac$x, frac$y)
    face <- text_fontface_to_weight_style(data$fontface %||% 1)
    editable <- list("text", "fontsize", "fontfamily", "fontweight", "fontstyle", "color")
    current_props <- list(
      text = latest_string(gid, "text", as.character(data$label %||% "")),
      fontsize = latest_numeric(gid, "fontsize", as.numeric(data$size %||% default_label$fontsize)),
      fontfamily = latest_string(gid, "fontfamily", as.character(data$family %||% "")),
      fontweight = latest_string(gid, "fontweight", face$fontweight),
      fontstyle = latest_string(gid, "fontstyle", face$fontstyle),
      color = latest_string(gid, "color", as.character(data$colour %||% "black")),
      data_x = as.numeric(data$x),
      data_y = as.numeric(data$y)
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
      id = gid,
      kind = "text",
      label = paste0("ggplot text ", item$layerIndex - 1, ".", item$rowIndex - 1),
      editable = editable,
      currentProps = current_props,
      role = "ggplot_text_annotation",
      subplotId = paste0("subplot.", panel - 1),
      source = list(artistClass = item$geom, axesIndex = panel - 1, zorder = item$layerIndex)
    )
  })
}

manifest_heatmap_colorbar_objects <- function(plot_obj) {
  continuous_scales <- find_continuous_colour_scales(plot_obj)
  if (length(continuous_scales) == 0) return(list())

  heatmap_layers <- list()
  if (length(plot_obj$layers) > 0) {
    for (i in seq_along(plot_obj$layers)) {
      geom <- geom_class(plot_obj$layers[[i]])
      if (geom %in% c("GeomTile", "GeomRaster", "GeomRect")) {
        heatmap_layers[[length(heatmap_layers) + 1]] <- i
      }
    }
  }
  if (length(heatmap_layers) == 0) return(list())

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
      source = list(artistClass = "ggplot_heatmap_scale", axesIndex = 0, zorder = scale_index)
    )

    objects[[length(objects) + 1]] <- list(
      id = colorbar_gid,
      kind = "colorbar",
      label = paste0("ggplot colorbar ", label),
      editable = list("label", "tick_fontsize", "visible", "left", "bottom", "width", "height"),
      currentProps = list(
        label = latest_string(colorbar_gid, "label", label),
        tick_fontsize = latest_numeric(colorbar_gid, "tick_fontsize", default_legend$fontsize),
        visible = latest_value(colorbar_gid, "visible", TRUE),
        left = latest_numeric(colorbar_gid, "left", default_colorbar$left),
        bottom = latest_numeric(colorbar_gid, "bottom", default_colorbar$bottom),
        width = latest_numeric(colorbar_gid, "width", default_colorbar$width),
        height = latest_numeric(colorbar_gid, "height", default_colorbar$height),
        vmin = latest_numeric(heatmap_gid, "vmin", current_vmin),
        vmax = latest_numeric(heatmap_gid, "vmax", current_vmax),
        cmap = latest_string(heatmap_gid, "cmap", "custom")
      ),
      role = "ggplot_colorbar",
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
    plans[[length(plans) + 1]] <- list(
      gid = paste0("r.layer.", i - 1),
      kind = kind,
      tags = tags,
      count = count,
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

get_element_group_gid <- function(plot_obj, layer_index, row_index, default_layer_gid, built_data) {
  if (is.null(plot_obj$scales) || length(plot_obj$scales$scales) == 0) {
    return(default_layer_gid)
  }
  if (length(built_data) < layer_index) {
    return(default_layer_gid)
  }

  data <- built_data[[layer_index]]
  if (is.null(data) || nrow(data) < row_index) {
    return(default_layer_gid)
  }

  row_data <- data[row_index, ]

  # Check manual scales in sequential order
  for (scale_index in seq_along(plot_obj$scales$scales)) {
    scale_obj <- plot_obj$scales$scales[[scale_index]]
    kind <- scale_kind(scale_obj)
    if (is.null(kind)) next
    if (!kind %in% c("fill", "color")) next

    values <- manual_scale_values(scale_obj)
    if (is.null(values)) next

    val_in_data <- if (kind == "fill") row_data$fill else row_data$colour
    if (is.null(val_in_data) || is.na(val_in_data)) next

    for (j in seq_along(values)) {
      group_id <- paste0("r.group.", kind, ".", scale_index - 1, ".", j - 1)
      orig_color <- as.character(values[[j]])
      current_color <- latest_string(group_id, if (kind == "fill") "facecolor" else "color", orig_color)

      if (colors_equal(val_in_data, current_color)) {
        return(group_id)
      }
    }
  }

  return(default_layer_gid)
}

inject_next_svg_tag_attrs <- function(svg, tags, gid, count, plot_obj, layer_index, built_data) {
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
    resolved_gid <- get_element_group_gid(plot_obj, layer_index, idx, gid, built_data)
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
  for (plan in plans) {
    svg <- inject_next_svg_tag_attrs(svg, plan$tags, plan$gid, plan$count, plot_obj, plan$layer_index, built_data)
  }
  svg
}

build_ggplot_manifest <- function(plot_obj) {
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
    latest_string("legend.0", "title", plot_obj$labels$colour %||% plot_obj$labels$color %||% plot_obj$labels$fill %||% "")
  )

  legend_visible_bool <- latest_bool("legend.0", "visible", TRUE)
  legend_loc <- latest_string("legend.0", "loc", "right")
  legend_face <- latest_string("legend.0", "facecolor", "white")
  legend_edge <- latest_string("legend.0", "edgecolor", "none")
  legend_lw <- latest_numeric("legend.0", "linewidth", 0.5)
  legend_alpha <- latest_numeric("legend.0", "alpha", 1.0)
  legend_ncol <- max(1L, as.integer(latest_numeric("legend.0", "ncol", default_legend$ncol)))
  legend_markerscale <- max(0.1, latest_numeric("legend.0", "markerscale", default_legend$markerscale))

  grid_visible <- latest_bool("grid.0", "visible", TRUE)
  grid_color <- latest_string("grid.0", "color", "#E5E5E5")
  grid_width <- latest_numeric("grid.0", "linewidth", 0.5)
  grid_style_str <- latest_string("grid.0", "linestyle", "solid")
  grid_alpha <- latest_numeric("grid.0", "alpha", 1.0)

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
      editable = list("title", "fontsize", "fontfamily", "fontweight", "fontstyle", "color", "visible", "loc", "ncol", "markerscale", "facecolor", "edgecolor", "linewidth", "alpha"),
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
        facecolor = legend_face,
        edgecolor = legend_edge,
        linewidth = legend_lw,
        alpha = legend_alpha
      ),
      role = "legend",
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
  objects <- c(objects, manifest_legend_text_objects(plot_obj, legend_title, legend_style))
  
  # Inject individual xtick and ytick objects into objects list
  built <- tryCatch(ggplot2::ggplot_build(plot_obj), error = function(e) NULL)
  if (!is.null(built) && !is.null(built$layout) && !is.null(built$layout$panel_params)) {
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
            source = list(artistClass = "ggplot_tick_label", axesIndex = p_idx - 1)
          )
        }
      }
    }
  }

  if (length(plot_obj$layers) > 0) {
    layer_objects <- lapply(seq_along(plot_obj$layers), function(i) manifest_layer_object(plot_obj$layers[[i]], i))
    objects <- c(objects, layer_objects)
  }
  text_layer_objects <- manifest_text_layer_objects(plot_obj)
  if (length(text_layer_objects) > 0) {
    objects <- c(objects, text_layer_objects)
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
  scale_semantics <- detect_manual_palettes(built_plot)
  if (length(scale_semantics$objects) > 0) {
    objects <- c(objects, scale_semantics$objects)
  }
  heatmap_colorbar_objects <- manifest_heatmap_colorbar_objects(plot_obj)
  if (length(heatmap_colorbar_objects) > 0) {
    objects <- c(objects, heatmap_colorbar_objects)
  }

  kind_counts <- table(vapply(objects, function(obj) obj$kind, character(1)))
  kind_count <- function(kind) {
    if (!kind %in% names(kind_counts)) return(0L)
    as.integer(kind_counts[[kind]])
  }
  by_kind <- list(
    text = list(count = kind_count("text"), editableProps = list("text", "fontsize", "fontfamily", "fontweight", "fontstyle", "color")),
    axis_x = list(count = kind_count("axis_x"), editableProps = list("label", "label_fontsize", "label_color", "tick_labelsize", "tick_labelfamily", "tick_labelcolor", "tick_fontweight", "tick_fontstyle", "limits", "tick_rotation", "tick_direction", "tick_length", "tick_width", "tick_color", "tick_pad")),
    axis_y = list(count = kind_count("axis_y"), editableProps = list("label", "label_fontsize", "label_color", "tick_labelsize", "tick_labelfamily", "tick_labelcolor", "tick_fontweight", "tick_fontstyle", "limits", "tick_rotation", "tick_direction", "tick_length", "tick_width", "tick_color", "tick_pad")),
    legend = list(count = kind_count("legend"), editableProps = list("title", "fontsize", "fontfamily", "fontweight", "fontstyle", "color", "visible", "loc", "ncol", "markerscale", "facecolor", "edgecolor", "linewidth", "alpha")),
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
      summary = list(recognized = length(objects), editable = length(objects), readonly = 0, unsupported = 0),
      byKind = by_kind,
      unsupportedArtists = list()
    ),
    unsupportedNotes = list(
      "R ggplot2 semantic editing currently covers labels, theme text, whole-layer geom styles, manual color/fill scales, facet panel discovery, and continuous heatmap/colorbar scales.",
      "R facet subplot aspect uses ggplot theme(aspect.ratio); independent left/bottom/width/height panel bounds are not equivalent to Matplotlib axes bounds.",
      "Drag-position replay and per-facet independent label styling are not enabled in this phase."
    )
  )
}

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

  if (requireNamespace("svglite", quietly = TRUE)) {
    svglite::svglite(file = tmp_svg, width = width, height = height)
  } else {
    grDevices::svg(filename = tmp_svg, width = width, height = height, onefile = TRUE)
  }
  on.exit({
    try(grDevices::dev.off(), silent = TRUE)
  }, add = TRUE)

  withCallingHandlers({
    eval(parse(text = script), envir = env)
    candidate_names <- c("p", "plot_obj", "figure", "fig")
    for (name in candidate_names) {
      if (exists(name, envir = env, inherits = FALSE)) {
        obj <- get(name, envir = env)
        if (inherits(obj, "ggplot")) {
          obj <- apply_ggplot_edits(obj)
          assign(name, obj, envir = env)
          print(obj)
          break
        }
      }
    }
  }, warning = function(w) {
    warnings_collected <<- c(warnings_collected, conditionMessage(w))
    invokeRestart("muffleWarning")
  })

  try(grDevices::dev.off(), silent = TRUE)
  svg <- paste(readLines(tmp_svg, warn = FALSE, encoding = "UTF-8"), collapse = "\n")

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

  manifest <- if (!is.null(ggplot_obj)) {
    build_ggplot_manifest(ggplot_obj)
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
        summary = list(recognized = 0, editable = 0, readonly = 0, unsupported = 0),
        byKind = list(),
        unsupportedArtists = list()
      ),
      unsupportedNotes = list(
        "R base plot rendering is currently SVG preview/export only.",
        "ggplot2 label/theme semantic editing is enabled when a ggplot object is assigned to p, plot_obj, figure, or fig."
      )
    )
  }

  if (!is.null(ggplot_obj)) {
    svg <- apply_svg_legend_text_edits(svg, manifest)
    svg <- inject_svg_text_ids(svg, manifest, ggplot_obj)
    svg <- inject_svg_layer_data_ids(svg, ggplot_obj)
  }

  list(status = "success", svg = svg, manifest = manifest, revision = 1, warnings = as.list(warnings_collected))
}, error = function(e) {
  list(
    status = "error",
    message = paste("R script failed:", conditionMessage(e)),
    traceback = paste(utils::capture.output(traceback()), collapse = "\n")
  )
})

try(unlink(tmp_svg), silent = TRUE)
cat(jsonlite::toJSON(result, auto_unbox = TRUE, null = "null", digits = NA))
quit(status = 0, save = "no", runLast = FALSE)
