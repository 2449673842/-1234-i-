library(ggplot2)

df <- data.frame(
  x = 1:3,
  y = c(2.0, 3.4, 2.7),
  label = c("Alpha", "Beta", "Gamma")
)
p <- ggplot(df, aes(x, y)) +
  geom_point(size = 2.6, color = "#2C7FB8") +
  geom_text(aes(label = label), vjust = -0.7) +
  geom_label(aes(label = paste0(label, " label")), vjust = 1.5, size = 3) +
  theme_classic()
p
