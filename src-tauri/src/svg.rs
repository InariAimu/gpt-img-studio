use crate::store::Result;
use resvg::{tiny_skia, usvg};

/// Keep exported SVG self-contained and inactive, as promised by the image API.
fn check_css(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    if lower.contains('@') || lower.contains('\\') || lower.contains("/*") || lower.contains("javascript:") {
        return false;
    }
    let mut rest = lower.as_str();
    while let Some(index) = rest.find("url(") {
        rest = &rest[index + 4..];
        let Some(end) = rest.find(')') else { return false };
        let reference = rest[..end].trim().trim_matches(['\'', '"']);
        if !reference.starts_with('#') || reference.len() < 2 { return false; }
        rest = &rest[end + 1..];
    }
    true
}

pub fn render(bytes: &[u8]) -> Result<(u32, u32, Vec<u8>)> {
    if bytes.is_empty() || bytes.len() > 8 * 1024 * 1024 { return Err("SVG 文件为空或超过 8 MB".into()); }
    let text = std::str::from_utf8(bytes).map_err(|_| "SVG 不是有效的 UTF-8")?;
    let doc = usvg::roxmltree::Document::parse(text).map_err(|e| format!("SVG 格式无效：{e}"))?;
    let root = doc.root_element();
    if root.tag_name().name() != "svg" || root.tag_name().namespace() != Some("http://www.w3.org/2000/svg") {
        return Err("SVG 根元素无效".into());
    }
    for node in doc.descendants() {
        if node.is_pi() { return Err("SVG 不能包含处理指令".into()); }
        if !node.is_element() { continue; }
        let tag = node.tag_name();
        if tag.namespace() != Some("http://www.w3.org/2000/svg") ||
            ["script", "foreignObject", "image", "a", "animate", "animateMotion", "animateTransform", "set"].contains(&tag.name()) {
            return Err("SVG 不能包含脚本、外部资源、嵌入图片或动态内容".into());
        }
        if tag.name() == "style" {
            let css: String = node.children().filter_map(|child| child.text()).collect();
            if !check_css(&css) { return Err("SVG 样式包含不支持的外部资源".into()); }
        }
        for attribute in node.attributes() {
            let name = attribute.name().to_ascii_lowercase();
            let value = attribute.value().trim();
            if name.starts_with("on") || ((name == "href" || name == "src") && !value.starts_with('#')) || !check_css(value) {
                return Err("SVG 包含不支持的脚本或外部资源".into());
            }
        }
    }
    let mut options = usvg::Options::default();
    options.image_href_resolver = usvg::ImageHrefResolver {
        resolve_data: Box::new(|_, _, _| None),
        resolve_string: Box::new(|_, _| None),
    };
    options.fontdb_mut().load_system_fonts();
    let tree = usvg::Tree::from_xmltree(&doc, &options).map_err(|e| format!("无法解析 SVG：{e}"))?;
    let size = tree.size();
    let (width, height) = (size.width().ceil() as u32, size.height().ceil() as u32);
    if width == 0 || height == 0 || width > 10_000 || height > 10_000 || u64::from(width) * u64::from(height) > 50_000_000 {
        return Err("SVG 尺寸超出支持范围".into());
    }
    let scale = (2048.0 / size.width().max(size.height())).min(1.0);
    let w = (size.width() * scale).ceil().max(1.0) as u32;
    let h = (size.height() * scale).ceil().max(1.0) as u32;
    let mut pixmap = tiny_skia::Pixmap::new(w, h).ok_or("无法创建 SVG 预览")?;
    resvg::render(&tree, tiny_skia::Transform::from_scale(scale, scale), &mut pixmap.as_mut());
    let png = pixmap.encode_png().map_err(|e| format!("无法编码 SVG 预览：{e}"))?;
    Ok((width, height, png))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn svg_preview_preserves_dimensions_and_rejects_active_content() {
        let svg = br##"<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60"><defs><linearGradient id="a"><stop stop-color="#ff0000"/></linearGradient></defs><rect width="120" height="60" fill="url(#a)"/></svg>"##;
        let (width, height, preview) = render(svg).unwrap();
        assert_eq!((width, height), (120, 60));
        assert_eq!(image::guess_format(&preview).unwrap(), image::ImageFormat::Png);
        assert!(render(br#"<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>"#).is_ok());
        for bad in [
            r#"<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>"#,
            r#"<svg xmlns="http://www.w3.org/2000/svg"><image href="file:///secret.png"/></svg>"#,
            r#"<svg xmlns="http://www.w3.org/2000/svg"><rect onload="alert(1)"/></svg>"#,
            r#"<svg xmlns="http://www.w3.org/2000/svg"><style>@import url(https://example.test/a)</style></svg>"#,
        ] { assert!(render(bad.as_bytes()).is_err()); }
    }
}
