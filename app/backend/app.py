import os
import io
from datetime import datetime
from flask import Flask, request, jsonify, current_app
from flask_cors import CORS
import logging
import re

# OCR + CV + ML imports
import pytesseract
from PIL import Image
import cv2
import numpy as np
import pandas as pd

# If Tesseract is installed in a custom path, uncomment and update this:
# pytesseract.pytesseract.tesseract_cmd = r"C:\Program Files\Tesseract-OCR\tesseract.exe"

# -------------------------------------------------------------
# 1) CREATE THE FLASK APP  (This was missing in your file)
# -------------------------------------------------------------
app = Flask(__name__)
CORS(app)


# -------------------------------------------------------------
# 2) THE /predict ROUTE
# -------------------------------------------------------------
@app.route("/predict", methods=["POST"])
def predict():
    try:
        # 1) pick uploaded file key (adjust if frontend uses 'image' or 'file')
        file = request.files.get("file") or request.files.get("image") or None
        if not file:
            current_app.logger.info("No file in request. Keys: %s", list(request.files.keys()))
            return jsonify({"error": "no file uploaded", "ok": False}), 400

        # 2) save file for debugging
        debug_dir = os.path.join(os.path.dirname(__file__), "tmp_debug")
        os.makedirs(debug_dir, exist_ok=True)
        saved_name = os.path.join(debug_dir, f"upload_{datetime.now().strftime('%Y%m%d_%H%M%S')}.jpg")
        file.save(saved_name)
        current_app.logger.info("Saved upload to %s (size=%d)", saved_name, os.path.getsize(saved_name))

        # 3) load image with OpenCV and preprocess for OCR
        img_bgr = cv2.imdecode(np.fromfile(saved_name, dtype=np.uint8), cv2.IMREAD_COLOR)
        if img_bgr is None:
            img_pil = Image.open(saved_name).convert("RGB")
            img_bgr = cv2.cvtColor(np.array(img_pil), cv2.COLOR_RGB2BGR)

        gray = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY)

        # Resize if too small
        h, w = gray.shape
        if max(h, w) < 1000:
            gray = cv2.resize(gray, (w*2, h*2), interpolation=cv2.INTER_LINEAR)

        # Noise removal + threshold
        gray = cv2.medianBlur(gray, 3)
        th = cv2.adaptiveThreshold(gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
                                   cv2.THRESH_BINARY, 31, 10)

        # Save preprocessed image
        preproc_path = os.path.join(debug_dir, f"pre_{os.path.basename(saved_name)}")
        cv2.imwrite(preproc_path, th)
        current_app.logger.info("Saved preprocessed image to %s", preproc_path)

        # 4) Tesseract OCR
        try:
            ocr_config = r'--oem 3 --psm 6'
            ocr_text = pytesseract.image_to_string(th, config=ocr_config)
        except Exception as e:
            current_app.logger.exception("pytesseract failed: %s", e)
            return jsonify({"error": "tesseract failed", "detail": str(e)}), 500

        current_app.logger.info("OCR length: %d, preview: %s", len(ocr_text), ocr_text[:300].replace("\n", " "))

        # 5) Extract ingredients heuristically
        text_lower = ocr_text.lower()
        ingredients_text = ""

        for marker in ["ingredients", "ingredients as served", "ingredient"]:
            idx = text_lower.find(marker)
            if idx != -1:
                snippet = ocr_text[idx:]
                stop_tokens = ["nutritional", "nutrition", "\n\n", "typical values"]
                stop_idx = None
                for t in stop_tokens:
                    si = snippet.lower().find(t)
                    if si != -1:
                        stop_idx = si
                        break
                ingredients_text = snippet if stop_idx is None else snippet[:stop_idx]
                break

        if not ingredients_text:
            ingredients_text = ocr_text

        # Split into tokens
        tokens = [t.strip() for t in re.split(r'[,\n;]+', ingredients_text) if t.strip()]

        # 6) Allergen + scoring
        allergens_found = []
        health_score = None
        
        try:
            csv_path = os.path.join(os.path.dirname(__file__), "ingredientsv1.csv")
            if os.path.exists(csv_path):
                df_ing = pd.read_csv(csv_path)
                df_ing['ingredient_lc'] = df_ing[df_ing.columns[0]].astype(str).str.lower()

                for t in tokens:
                    tl = t.lower()
                    matches = df_ing[df_ing['ingredient_lc'].str.contains(re.escape(tl))]
                    if not matches.empty:
                        allergens_found.extend(matches[df_ing.columns[0]].astype(str).tolist())

                if 'impact' in df_ing.columns:
                    impacts = []
                    for t in tokens:
                        tl = t.lower()
                        rows = df_ing[df_ing['ingredient_lc'].str.contains(re.escape(tl))]
                        impacts += rows['impact'].astype(float).tolist()
                    if impacts:
                        health_score = max(0, 100 - sum(impacts))
            else:
                current_app.logger.info("ingredientsv1.csv not found at %s", csv_path)
        except Exception as e:
            current_app.logger.exception("CSV parsing failed: %s", e)

        # Fallback allergen detection
        if not allergens_found:
            sample_allergens = ["milk", "egg", "eggs", "peanut", "peanuts", "soy", "wheat", "gluten", "fish", "shellfish", "tree nut", "almond", "cashew"]
            for t in tokens:
                tl = t.lower()
                for a in sample_allergens:
                    if a in tl:
                        allergens_found.append(a)

        # Fallback scoring
        if health_score is None:
            bad_words = ["sugar", "salt", "sodium", "hydrogenated", "trans",
                         "palmitate", "fat", "fatty", "oil", "flavour", "flavor"]
            penalty = 0
            for t in tokens:
                tl = t.lower()
                for k in bad_words:
                    if k in tl:
                        penalty += 5
            health_score = max(0, 100 - penalty)

        # 7) Response
        resp = {
            "ok": True,
            "ocr_text": ocr_text,
            "ingredients_text": ingredients_text,
            "tokens": tokens[:200],
            "allergens": sorted(set(allergens_found)),
            "health_score": int(health_score)
        }
        return jsonify(resp), 200

    except Exception as e:
        current_app.logger.exception("Unhandled exception in /predict: %s", e)
        return jsonify({"error": "server error", "detail": str(e)}), 500


# -------------------------------------------------------------
# 3) RUN THE APP
# -------------------------------------------------------------
if __name__ == "__main__":
    app.run(debug=True)
