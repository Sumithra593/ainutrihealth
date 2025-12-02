# test_ocr_preproc.py
import os
from PIL import Image, ImageOps, ImageEnhance
import cv2
import numpy as np
import pytesseract

# Set tesseract binary path if needed (Windows)
pytesseract.pytesseract.tesseract_cmd = r"C:\Program Files\Tesseract-OCR\tesseract.exe"

IMG_PATH = r"C:\Users\user\Downloads\image.png"
OUT_DIR = r".\ocr_debug_outputs"
os.makedirs(OUT_DIR, exist_ok=True)

# Tesseract common config: tune psm/oem as needed
BASE_CONFIG = "--oem 1"  # 1 = LSTM only; try 3 for default (legacy + LSTM) if needed

def load_image(path):
    assert os.path.exists(path), f"Image not found: {path}"
    pil = Image.open(path).convert("RGB")
    return pil

def pil_to_cv(img_pil):
    return cv2.cvtColor(np.array(img_pil), cv2.COLOR_RGB2BGR)

def cv_to_pil(img_cv):
    return Image.fromarray(cv2.cvtColor(img_cv, cv2.COLOR_BGR2RGB))

def resize_for_ocr(img_cv, target_dpi=300):
    # Upscale image to simulate higher DPI. We operate in pixels; choose scale factor
    # based on original width — common target widths: 1024..2400 depending on input
    h, w = img_cv.shape[:2]
    # choose scale so that the smallest dimension becomes >= target_dpi * 2 (heuristic)
    scale = max(1.0, (target_dpi*2) / min(h, w))
    new_w = int(w * scale)
    new_h = int(h * scale)
    resized = cv2.resize(img_cv, (new_w, new_h), interpolation=cv2.INTER_CUBIC)
    return resized

def deskew_image(img_gray):
    # Compute angle of rotation using the largest contour / minAreaRect
    thresh = cv2.threshold(img_gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)[1]
    coords = np.column_stack(np.where(thresh < 255))  # text = non-white
    if coords.shape[0] < 10:
        return img_gray, 0.0
    rect = cv2.minAreaRect(coords)
    angle = rect[-1]
    # Rect angle behavior: sometimes angle is in [-90, 0)
    if angle < -45:
        angle = angle + 90
    (h, w) = img_gray.shape[:2]
    center = (w // 2, h // 2)
    M = cv2.getRotationMatrix2D(center, angle, 1.0)
    rotated = cv2.warpAffine(img_gray, M, (w, h), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)
    return rotated, angle

def enhance_contrast(img_pil, factor=1.5):
    enhancer = ImageEnhance.Contrast(img_pil)
    return enhancer.enhance(factor)

def sharpen_image_cv(img_cv):
    kernel = np.array([[0, -1,  0],
                       [-1, 5, -1],
                       [0, -1,  0]])
    return cv2.filter2D(img_cv, -1, kernel)

def preprocess_variants(img_pil):
    """
    Yields tuples (name, preprocessed_cv_image) for different strategies.
    We'll try several reasonable pipelines and let heuristics choose the best.
    """
    base_cv = pil_to_cv(img_pil)
    # 1. Resize
    resized = resize_for_ocr(base_cv, target_dpi=300)

    # Convert to gray
    gray = cv2.cvtColor(resized, cv2.COLOR_BGR2GRAY)

    variants = {}

    # Variant A: simple adaptive thresholding (good for uneven lighting)
    a = cv2.adaptiveThreshold(gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
                              cv2.THRESH_BINARY, 31, 10)
    variants['adaptive_thresh'] = a

    # Variant B: bilateral filter -> adaptive threshold (denoise while keeping edges)
    b = cv2.bilateralFilter(gray, d=9, sigmaColor=75, sigmaSpace=75)
    b = cv2.adaptiveThreshold(b, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
                              cv2.THRESH_BINARY, 31, 10)
    variants['bilateral+adapt'] = b

    # Variant C: Otsu after gaussian blur
    c = cv2.GaussianBlur(gray, (5,5), 0)
    _, c = cv2.threshold(c, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    variants['gauss+otsu'] = c

    # Variant D: sharpen + Otsu
    sharp = sharpen_image_cv(resized)
    dgray = cv2.cvtColor(sharp, cv2.COLOR_BGR2GRAY)
    _, d = cv2.threshold(dgray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    variants['sharpen+otsu'] = d

    # Variant E: inverted adaptive (useful for light-on-dark)
    e = cv2.bitwise_not(variants['adaptive_thresh'])
    variants['inv_adapt'] = e

    # Variant F: deskewed + otsu
    deskewed_gray, ang = deskew_image(gray)
    _, f = cv2.threshold(deskewed_gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    variants[f'deskew_otsu_{int(ang)}deg'] = f

    # Convert single-channel images to 3-channel BGR for saving convenience
    for k, v in list(variants.items()):
        if len(v.shape) == 2:
            variants[k] = cv2.cvtColor(v, cv2.COLOR_GRAY2BGR)

    return variants

def ocr_image_cv(img_cv, extra_config="--psm 6"):
    pil = cv_to_pil(img_cv)
    text = pytesseract.image_to_string(pil, config=f"{BASE_CONFIG} {extra_config} -l eng")
    return text

def score_text(text):
    # Very simple heuristic score: count words and penalize too-short results
    if not text:
        return 0
    words = [w for w in text.split() if len(w) > 1]
    return len(words)

def main():
    pil = load_image(IMG_PATH)
    print("Image size (w,h):", pil.size)

    # Try multiple preprocess pipelines
    variants = preprocess_variants(pil)
    results = []
    for name, img_cv in variants.items():
        out_path = os.path.join(OUT_DIR, f"{name}.png")
        cv2.imwrite(out_path, img_cv)
        # Try a couple of PSM modes: 6 = assume a single uniform block of text,
        # 3 = fully automatic page segmentation, 11 = sparse text
        best_text_for_variant = ""
        best_score = -1
        for psm in ["--psm 6", "--psm 3", "--psm 11"]:
            try:
                txt = ocr_image_cv(img_cv, extra_config=psm)
            except Exception as e:
                txt = ""
            sc = score_text(txt)
            if sc > best_score:
                best_score = sc
                best_text_for_variant = txt
        results.append((name, best_score, best_text_for_variant, out_path))

    # Choose the highest scoring result
    results_sorted = sorted(results, key=lambda x: x[1], reverse=True)
    for name, score, txt, path in results_sorted:
        print(f"--- Variant: {name}, score={score}, saved={path} ---")
        print(txt[:1000])  # print first 1000 chars for brevity
        print("-------------------------------------------------------\n")

    if results_sorted:
        best_name, best_score, best_txt, best_path = results_sorted[0]
        print(f"\n=== Best result: {best_name} (score {best_score}) saved at {best_path} ===\n")
        print(best_txt)
    else:
        print("No OCR results produced.")

if __name__ == "__main__":
    main()
