library(ggplot2)

df <- data.frame(category = c("A", "B", "C", "D"), value = c(3, 5, 4, 2))
p <- ggplot(df, aes(category, value, fill = category)) +
  geom_col(width = 0.8) +
  geom_text(aes(label = value), position = position_stack(vjust = 0.5)) +
  coord_polar(theta = "x") +
  theme_void()
p
