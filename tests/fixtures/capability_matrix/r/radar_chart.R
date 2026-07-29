library(ggplot2)

radar_dimensions <- c("Quality", "Speed", "Cost", "Reliability", "Safety")
radar_data <- data.frame(
  series = rep(c("Control", "Treatment"), each = length(radar_dimensions) + 1L),
  dimension = rep(c(radar_dimensions, radar_dimensions[[1]]), 2L),
  value = c(
    0.72, 0.58, 0.66, 0.81, 0.63, 0.72,
    0.84, 0.76, 0.52, 0.88, 0.79, 0.84
  ),
  stringsAsFactors = FALSE
)
radar_data$dimension <- factor(radar_data$dimension, levels = radar_dimensions)

p <- ggplot(
  radar_data,
  aes(x = dimension, y = value, group = series, colour = series, fill = series)
) +
  geom_polygon(alpha = 0.20, linewidth = 0.8) +
  geom_line(linewidth = 1.0) +
  geom_point(size = 2.0) +
  scale_color_manual(values = c(Control = "#006D5B", Treatment = "#D55E00"), name = "Group") +
  scale_fill_manual(values = c(Control = "#6FCF97", Treatment = "#E69F00"), name = "Group") +
  coord_polar() +
  scale_y_continuous(limits = c(0, 1), breaks = c(0.25, 0.5, 0.75, 1.0)) +
  labs(title = "Treatment response radar", x = NULL, y = NULL) +
  theme_minimal(base_size = 10) +
  theme(
    legend.position = "right",
    panel.grid.major = element_line(colour = "#B8C2CC", linewidth = 0.35),
    axis.text.x = element_text(face = "bold")
  )

p
